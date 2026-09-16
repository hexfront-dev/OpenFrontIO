import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import {
  GAME_ID_REGEX,
  type SavedLobby,
  type SavedLobbyMeta,
  SavedLobbyMetaSchema,
  SavedLobbySchema,
  savedLobbyMetaFrom,
} from "../core/Schemas";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

// Persistence for resumable private lobbies/games. A store is scoped to one
// shard's directory, so a save written by worker N is read by worker N (the
// same placement rule that routes a gameID to its worker — see
// ServerEnv.workerIndex). Implementations must never leak a SavedLobby to a
// browser: it carries account persistentIDs.
export interface ServerSaveStore {
  save(snapshot: SavedLobby): Promise<void>;
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

export class MemorySaveStore implements ServerSaveStore {
  private saves = new Map<string, SavedLobby>();

  async save(snapshot: SavedLobby): Promise<void> {
    // Round-trip through the schema so a memory store enforces the same
    // invariants a filesystem store would on read.
    this.saves.set(snapshot.gameID, SavedLobbySchema.parse(snapshot));
  }

  async load(gameID: string): Promise<SavedLobby | null> {
    const save = this.saves.get(gameID);
    return save === undefined ? null : SavedLobbySchema.parse(save);
  }

  async list(creatorPersistentID: string): Promise<SavedLobbyMeta[]> {
    return [...this.saves.values()]
      .filter((s) => s.creatorPersistentID === creatorPersistentID)
      .map((s) => savedLobbyMetaFrom(s))
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  async delete(gameID: string): Promise<void> {
    this.saves.delete(gameID);
  }
}

// One gzipped JSON blob per game, plus a small uncompressed meta file so a
// listing never has to decompress full histories. Files live under a
// per-worker directory so NUM_WORKERS can change without cross-reading another
// shard's saves by accident (a mismatched shard simply sees none).
export class FilesystemSaveStore implements ServerSaveStore {
  constructor(private readonly dir: string) {}

  private savePath(gameID: string): string {
    assertGameID(gameID);
    return path.join(this.dir, `${gameID}.json.gz`);
  }

  private metaPath(gameID: string): string {
    assertGameID(gameID);
    return path.join(this.dir, `${gameID}.meta.json`);
  }

  async save(snapshot: SavedLobby): Promise<void> {
    const parsed = SavedLobbySchema.parse(snapshot);
    await mkdir(this.dir, { recursive: true });
    const meta = savedLobbyMetaFrom(parsed);
    const json = JSON.stringify(parsed);
    const compressed = await gzip(Buffer.from(json, "utf8"));
    // Meta first, then the payload: a crash between the two leaves a stale meta
    // pointing at a missing payload, which load() reports as not-found rather
    // than a half-written save.
    await writeFile(this.metaPath(parsed.gameID), JSON.stringify(meta));
    await writeFile(this.savePath(parsed.gameID), compressed);
  }

  async load(gameID: string): Promise<SavedLobby | null> {
    // Validate before the try: a malformed id is a caller bug, not a missing
    // file, and must not be swallowed as "not found".
    assertGameID(gameID);
    try {
      const compressed = await readFile(this.savePath(gameID));
      const json = (await gunzip(compressed)).toString("utf8");
      return SavedLobbySchema.parse(JSON.parse(json));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // A corrupt/unreadable save must not crash the caller; it is treated
        // like a missing one.
        console.error(`failed to load save ${gameID}:`, error);
      }
      return null;
    }
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
    await rm(this.savePath(gameID), { force: true });
    await rm(this.metaPath(gameID), { force: true });
  }
}
