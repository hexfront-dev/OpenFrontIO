import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import {
  GAME_ID_REGEX,
  SavedLobbyHeadSchema,
  SavedLobbyMetaSchema,
  SavedLobbySchema,
  TurnSchema,
  savedLobbyHeadFrom,
  savedLobbyMetaFromHead,
  type SavedLobby,
  type SavedLobbyHead,
  type SavedLobbyMeta,
  type Turn,
} from "../core/Schemas";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

// Persistence for resumable private lobbies/games. A store is scoped to one
// shard's directory, so a save written by worker N is read by worker N (the
// same placement rule that routes a gameID to its worker — see
// ServerEnv.workerIndex). Implementations must never leak a SavedLobby to a
// browser: it carries account persistentIDs.
//
// B0: a save is split into a small mutable "head" (config/seats/stage, rewritten
// every autosave) and an append-only turn history. `save(snapshot, fromTurn)`
// only validates/encodes the head and the turns at index >= fromTurn, so an
// autosave is O(delta) instead of re-parsing + re-stringifying O(history).
export interface ServerSaveStore {
  save(snapshot: SavedLobby, fromTurn?: number): Promise<void>;
  load(gameID: string): Promise<SavedLobby | null>;
  // Newest first, for the host's resume list. Filtered by creator server-side.
  list(creatorPersistentID: string): Promise<SavedLobbyMeta[]>;
  delete(gameID: string): Promise<void>;
}

// Default dep for GameServerDeps: a game that never persists and can never be
// loaded. Tests that exercise resume inject a MemorySaveStore instead.
export const noopSaveStore: ServerSaveStore = {
  async save() {},
  async load() {
    return null;
  },
  async list() {
    return [];
  },
  async delete() {},
};

function assertGameID(gameID: string): void {
  if (!GAME_ID_REGEX.test(gameID)) {
    throw new Error(`invalid game id for save store: ${gameID}`);
  }
}

// Rebuild a dense turn array (index == turnNumber) from a sparse/numbered list.
function densifyTurns(turns: Turn[], numTurns: number): Turn[] {
  const byNumber = new Map<number, Turn>();
  for (const turn of turns) {
    byNumber.set(turn.turnNumber, turn);
  }
  const dense: Turn[] = [];
  for (let i = 0; i < numTurns; i++) {
    dense.push(byNumber.get(i) ?? { turnNumber: i, intents: [] });
  }
  return dense;
}

export class MemorySaveStore implements ServerSaveStore {
  private heads = new Map<string, SavedLobbyHead>();
  private turns = new Map<string, Turn[]>();
  private checkpoints = new Map<string, string>();

  async save(snapshot: SavedLobby, fromTurn = 0): Promise<void> {
    // Round-trip only the head + delta through the schema so a memory store
    // enforces the same invariants a filesystem store would on read.
    const head = SavedLobbyHeadSchema.parse(savedLobbyHeadFrom(snapshot));
    const delta = TurnSchema.array().parse(snapshot.turns.slice(fromTurn));
    this.heads.set(head.gameID, head);
    const stored = this.turns.get(head.gameID) ?? [];
    for (const turn of delta) {
      stored[turn.turnNumber] = turn;
    }
    this.turns.set(head.gameID, stored);
    if (snapshot.checkpoint !== undefined) {
      this.checkpoints.set(head.gameID, snapshot.checkpoint);
    } else {
      // A later save without a checkpoint must not resurrect the old one.
      this.checkpoints.delete(head.gameID);
    }
  }

  async load(gameID: string): Promise<SavedLobby | null> {
    const head = this.heads.get(gameID);
    if (head === undefined) {
      return null;
    }
    const turns = densifyTurns(this.turns.get(gameID) ?? [], head.numTurns);
    const checkpoint = this.checkpoints.get(gameID);
    return SavedLobbySchema.parse({
      ...head,
      turns,
      ...(checkpoint !== undefined ? { checkpoint } : {}),
    });
  }

  async list(creatorPersistentID: string): Promise<SavedLobbyMeta[]> {
    return [...this.heads.values()]
      .filter((h) => h.creatorPersistentID === creatorPersistentID)
      .map((h) => savedLobbyMetaFromHead(h))
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  async delete(gameID: string): Promise<void> {
    this.heads.delete(gameID);
    this.turns.delete(gameID);
    this.checkpoints.delete(gameID);
  }
}

// Split layout under a per-worker directory:
//   <gameID>.head.json   small, uncompressed mutable head (rewritten per save)
//   <gameID>.history.gz  append-only history; one JSON turn per line, each
//                        autosave appends a fresh gzip member (gunzip decodes
//                        concatenated members transparently)
//   <gameID>.meta.json   small uncompressed listing row (never decompressed)
// Legacy single-blob saves (<gameID>.json.gz) are still read as a fallback.
export class FilesystemSaveStore implements ServerSaveStore {
  // B0/Phase 3: identity of the checkpoint already written to the sidecar, so a
  // periodic autosave whose checkpoint is unchanged does not re-gzip and
  // rewrite the (potentially megabyte-scale) blob. Reset on process restart,
  // which costs one redundant write per game.
  private readonly persistedCheckpoints = new Map<string, string>();
  /** Number of checkpoint sidecar writes performed (telemetry/tests). */
  public checkpointWrites = 0;

  constructor(private readonly dir: string) {}

  private headPath(gameID: string): string {
    assertGameID(gameID);
    return path.join(this.dir, `${gameID}.head.json`);
  }

  private historyPath(gameID: string): string {
    assertGameID(gameID);
    return path.join(this.dir, `${gameID}.history.gz`);
  }

  private metaPath(gameID: string): string {
    assertGameID(gameID);
    return path.join(this.dir, `${gameID}.meta.json`);
  }

  private legacyPath(gameID: string): string {
    assertGameID(gameID);
    return path.join(this.dir, `${gameID}.json.gz`);
  }

  private checkpointPath(gameID: string): string {
    assertGameID(gameID);
    return path.join(this.dir, `${gameID}.checkpoint.json.gz`);
  }

  async save(snapshot: SavedLobby, fromTurn = 0): Promise<void> {
    const head = SavedLobbyHeadSchema.parse(savedLobbyHeadFrom(snapshot));
    // Slice before the first await: snapshot.turns aliases the live server array,
    // which keeps growing while this write is in flight.
    const delta = TurnSchema.array().parse(snapshot.turns.slice(fromTurn));
    await mkdir(this.dir, { recursive: true });
    if (delta.length > 0) {
      const lines = delta.map((t) => JSON.stringify(t)).join("\n") + "\n";
      const compressed = await gzip(Buffer.from(lines, "utf8"));
      await appendFile(this.historyPath(snapshot.gameID), compressed);
    }
    // History first, then head, then meta: a crash before the head lands leaves
    // the old head (a consistent, older save) since load clamps to numTurns.
    await writeFile(this.headPath(snapshot.gameID), JSON.stringify(head));
    await writeFile(
      this.metaPath(snapshot.gameID),
      JSON.stringify(savedLobbyMetaFromHead(head)),
    );
    // A megabyte-scale sidecar, gzipped and kept off the JSON head. Written
    // last: a crash before it lands leaves the checkpoint missing (full-replay
    // fallback) rather than a head claiming one that is not there. Rewritten
    // only when the checkpoint actually changed, so a periodic autosave with an
    // unchanged checkpoint (the common case) skips the gzip + write entirely.
    const checkpoint = snapshot.checkpoint;
    if (checkpoint !== undefined) {
      if (this.persistedCheckpoints.get(snapshot.gameID) !== checkpoint) {
        const compressed = await gzip(Buffer.from(checkpoint, "utf8"));
        await writeFile(this.checkpointPath(snapshot.gameID), compressed);
        this.persistedCheckpoints.set(snapshot.gameID, checkpoint);
        this.checkpointWrites++;
      }
    } else {
      // A save without a checkpoint must not resurrect a stale sidecar.
      await rm(this.checkpointPath(snapshot.gameID), { force: true });
      this.persistedCheckpoints.delete(snapshot.gameID);
    }
  }

  async load(gameID: string): Promise<SavedLobby | null> {
    // Validate before the try: a malformed id is a caller bug, not a missing
    // file, and must not be swallowed as "not found".
    assertGameID(gameID);
    try {
      const headRaw = await readFile(this.headPath(gameID), "utf8");
      const head = SavedLobbyHeadSchema.parse(JSON.parse(headRaw));
      const turns = await this.readHistory(gameID, head.numTurns);
      const checkpoint = await this.readCheckpoint(gameID);
      return SavedLobbySchema.parse({
        ...head,
        turns,
        ...(checkpoint !== undefined ? { checkpoint } : {}),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // No split save here; fall back to a legacy single-blob save.
        return this.loadLegacy(gameID);
      }
      // A corrupt/unreadable save must not crash the caller; it is treated
      // like a missing one.
      console.error(`failed to load save ${gameID}:`, error);
      return null;
    }
  }

  private async loadLegacy(gameID: string): Promise<SavedLobby | null> {
    try {
      const compressed = await readFile(this.legacyPath(gameID));
      const json = (await gunzip(compressed)).toString("utf8");
      return SavedLobbySchema.parse(JSON.parse(json));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error(`failed to load save ${gameID}:`, error);
      }
      return null;
    }
  }

  // The optional checkpoint sidecar. Absent (or unreadable) means "no
  // checkpoint": the caller resumes from the full history.
  private async readCheckpoint(gameID: string): Promise<string | undefined> {
    let compressed: Buffer;
    try {
      compressed = await readFile(this.checkpointPath(gameID));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw error;
    }
    try {
      return (await gunzip(compressed)).toString("utf8");
    } catch (error) {
      // A corrupt sidecar must not fail the whole load; drop to full replay.
      console.error(`failed to read checkpoint for ${gameID}:`, error);
      return undefined;
    }
  }

  private async readHistory(gameID: string, numTurns: number): Promise<Turn[]> {
    let text: string;
    try {
      const compressed = await readFile(this.historyPath(gameID));
      text = (await gunzip(compressed)).toString("utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const turns: Turn[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      turns.push(TurnSchema.parse(JSON.parse(trimmed)));
    }
    // numTurns is the authoritative length: if the last append half-landed or
    // the head is slightly ahead, clamp/ignore extras rather than serve a save
    // whose turn numbers drift past the recorded count.
    return densifyTurns(turns, numTurns);
  }

  async list(creatorPersistentID: string): Promise<SavedLobbyMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const metas: SavedLobbyMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".meta.json")) continue;
      try {
        const raw = await readFile(path.join(this.dir, entry), "utf8");
        const meta = SavedLobbyMetaSchema.parse(JSON.parse(raw));
        if (meta.creatorPersistentID === creatorPersistentID) {
          metas.push(meta);
        }
      } catch {
        // Skip an unreadable meta rather than failing the whole listing.
      }
    }
    return metas.sort((a, b) => b.savedAt - a.savedAt);
  }

  async delete(gameID: string): Promise<void> {
    await rm(this.headPath(gameID), { force: true });
    await rm(this.historyPath(gameID), { force: true });
    await rm(this.metaPath(gameID), { force: true });
    await rm(this.legacyPath(gameID), { force: true });
    await rm(this.checkpointPath(gameID), { force: true });
    this.persistedCheckpoints.delete(gameID);
  }
}
