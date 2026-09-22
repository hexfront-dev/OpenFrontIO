import {
  ClientID,
  GameStartInfo,
  SAVED_GAME_VERSION,
  SavedGameHead,
  Turn,
} from "../core/Schemas";
import { ClientEnv } from "./ClientEnv";
import { saveGameProgress } from "./SaveStore";

const SAVE_EVERY_TURNS = 25;

/**
 * A core checkpoint as it is persisted and uploaded: the encoded wire string
 * (tagged-JSON or `gz:` gzip, see core/CheckpointCodec.ts) plus the turn it
 * covers. The worker encodes it, so the main thread never serializes it.
 */
export interface CheckpointTransfer {
  wire: string;
  ticks: number;
}

export class SaveManager {
  private startInfo: GameStartInfo | null = null;
  private myClientID: ClientID | undefined;
  // Phase 5: retain only the not-yet-persisted tail plus a total count, instead
  // of the whole dense history for the life of the game. `turns[i]` is the turn
  // numbered `turnsBase + i`.
  private turns: Turn[] = [];
  private turnsBase = 0;
  private numTurns = 0;
  private lastPersistedTurn = -1;
  private saving = false;
  private dirty = false;
  private disposed = false;
  private listening = false;
  private checkpointProvider: (() => CheckpointTransfer | undefined) | null =
    null;

  /**
   * B2: install a provider for the latest core checkpoint (wire string + tick).
   * Called once per autosave; only attached when its tick is within the turns
   * recorded here.
   */
  public setCheckpointProvider(
    provider: (() => CheckpointTransfer | undefined) | null,
  ) {
    this.checkpointProvider = provider;
  }

  private readonly onPageHide = () => {
    void this.persist();
  };

  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      void this.persist();
    }
  };

  public begin(startInfo: GameStartInfo, myClientID: ClientID | undefined) {
    this.startInfo = startInfo;
    this.myClientID = myClientID;
    this.turns = [];
    this.turnsBase = 0;
    this.numTurns = 0;
    this.lastPersistedTurn = -1;
    if (!this.listening && typeof window !== "undefined") {
      this.listening = true;
      window.addEventListener("pagehide", this.onPageHide);
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  public recordTurn(turn: Turn) {
    if (this.startInfo === null || this.disposed) {
      return;
    }
    const index = turn.turnNumber - this.turnsBase;
    if (index < 0) {
      // Already persisted and dropped; a late duplicate is a no-op.
      return;
    }
    this.turns[index] = turn;
    if (turn.turnNumber >= this.numTurns) {
      this.numTurns = turn.turnNumber + 1;
    }
    this.dirty = true;
    if (turn.turnNumber - this.lastPersistedTurn >= SAVE_EVERY_TURNS) {
      void this.persist();
    }
  }

  /**
   * Persist the current save. `force` writes even when no turn has arrived since
   * the last autosave, so a manual checkpoint (the in-game save button) still
   * updates the stored head immediately.
   */
  public async persist(force = false): Promise<void> {
    if (
      this.startInfo === null ||
      this.disposed ||
      this.saving ||
      (!force && !this.dirty)
    ) {
      return;
    }
    this.saving = true;
    this.dirty = false;
    // B0: append only the turns recorded since the last write, instead of
    // rebuilding and re-validating the whole (dense) history every autosave.
    const firstWrite = this.lastPersistedTurn === -1;
    const newTurns = this.turnsSince(this.lastPersistedTurn + 1);
    const persistedThrough = this.numTurns - 1;
    const startInfo = this.startInfo;
    // B2: attach the most recent core checkpoint, but only if every turn it
    // already covers is part of this save (otherwise the suffix would be
    // incomplete on resume).
    let checkpoint: string | undefined;
    try {
      const candidate = this.checkpointProvider?.();
      if (candidate !== undefined && candidate.ticks <= this.numTurns) {
        checkpoint = candidate.wire;
      }
    } catch (error) {
      console.error("Failed to capture checkpoint", error);
    }
    const head: SavedGameHead = {
      version: SAVED_GAME_VERSION,
      saveId: startInfo.gameID,
      gameID: startInfo.gameID,
      label: this.label(startInfo),
      savedAt: Date.now(),
      gitCommit: ClientEnv.gitCommit(),
      myClientID: this.myClientID,
      startInfo,
      checkpoint,
      numTurns: this.numTurns,
    };
    try {
      await saveGameProgress(head, newTurns, firstWrite);
      // Advance only on success so a failed write is retried in full, then drop
      // the persisted prefix: the tail now lives in IndexedDB.
      if (persistedThrough > this.lastPersistedTurn) {
        this.lastPersistedTurn = persistedThrough;
      }
      this.dropPersisted();
    } catch (error) {
      console.error("Failed to save game", error);
      this.dirty = true;
    } finally {
      this.saving = false;
      if (this.dirty && !this.disposed) {
        void this.persist();
      }
    }
  }

  public dispose() {
    void this.persist();
    this.disposed = true;
    if (this.listening) {
      this.listening = false;
      window.removeEventListener("pagehide", this.onPageHide);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  private label(startInfo: GameStartInfo): string {
    const player = startInfo.players[0]?.username;
    return player
      ? `${startInfo.config.gameMap} · ${player}`
      : startInfo.config.gameMap;
  }

  // Dense slice [from, numTurns): turns are numbered by index, so a gap is a
  // turn with no intents. O(delta), never O(history).
  private turnsSince(from: number): Turn[] {
    const turns: Turn[] = [];
    const start = Math.max(from, this.turnsBase);
    for (let i = start; i < this.numTurns; i++) {
      turns.push(
        this.turns[i - this.turnsBase] ?? { turnNumber: i, intents: [] },
      );
    }
    return turns;
  }

  // Drop the prefix already written to IndexedDB. O(remaining tail).
  private dropPersisted(): void {
    const newBase = this.lastPersistedTurn + 1;
    if (newBase <= this.turnsBase) {
      return;
    }
    this.turns = this.turns.slice(newBase - this.turnsBase);
    this.turnsBase = newBase;
  }
}
