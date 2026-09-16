import {
  ClientID,
  GameStartInfo,
  SAVED_GAME_VERSION,
  SavedGame,
  Turn,
} from "../core/Schemas";
import { ClientEnv } from "./ClientEnv";
import { saveGame } from "./SaveStore";

const SAVE_EVERY_TURNS = 25;

export class SaveManager {
  private startInfo: GameStartInfo | null = null;
  private myClientID: ClientID | undefined;
  private turns: Turn[] = [];
  private lastPersistedTurn = -1;
  private saving = false;
  private dirty = false;
  private disposed = false;
  private listening = false;

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
    this.turns[turn.turnNumber] = turn;
    this.dirty = true;
    if (turn.turnNumber - this.lastPersistedTurn >= SAVE_EVERY_TURNS) {
      void this.persist();
    }
  }

  public async persist(): Promise<void> {
    if (
      this.startInfo === null ||
      this.disposed ||
      this.saving ||
      !this.dirty
    ) {
      return;
    }
    this.saving = true;
    this.dirty = false;
    const turns = this.denseTurns();
    this.lastPersistedTurn = turns.length - 1;
    const startInfo = this.startInfo;
    const save: SavedGame = {
      version: SAVED_GAME_VERSION,
      saveId: startInfo.gameID,
      gameID: startInfo.gameID,
      label: this.label(startInfo),
      savedAt: Date.now(),
      gitCommit: ClientEnv.gitCommit(),
      myClientID: this.myClientID,
      startInfo,
      turns,
    };
    try {
      await saveGame(save);
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

  private denseTurns(): Turn[] {
    const turns: Turn[] = [];
    for (let i = 0; i < this.turns.length; i++) {
      turns.push(this.turns[i] ?? { turnNumber: i, intents: [] });
    }
    return turns;
  }
}
