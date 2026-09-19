import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../src/client/ClientEnv";
import { SaveManager } from "../src/client/SaveManager";
import {
  loadSave,
  MemorySaveBackend,
  setSaveBackend,
} from "../src/client/SaveStore";
import type { GameCheckpoint } from "../src/core/Checkpoint";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../src/core/game/Game";
import { GameStartInfo } from "../src/core/Schemas";

function startInfo(): GameStartInfo {
  return {
    gameID: "GAME0001",
    lobbyCreatedAt: 1_600_000_000_000,
    config: {
      gameMap: GameMapType.Asia,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Medium,
      nations: "default",
      donateGold: false,
      donateTroops: false,
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    },
    players: [{ clientID: "CLIENT01", username: "Alice", clanTag: null }],
  };
}

describe("SaveManager append-only autosave", () => {
  let backend: MemorySaveBackend;

  beforeEach(() => {
    ClientEnv.reset();
    (window as unknown as { BOOTSTRAP_CONFIG: object }).BOOTSTRAP_CONFIG = {
      gameEnv: "dev",
      numWorkers: 1,
      turnstileSiteKey: "",
      jwtAudience: "localhost",
      instanceId: "test",
      gitCommit: "DEV",
    };
    backend = new MemorySaveBackend();
    setSaveBackend(backend);
  });

  it("writes the first autosave in full and later ones as a delta", async () => {
    const append = vi.spyOn(backend, "appendTurns");
    const manager = new SaveManager();
    manager.begin(startInfo(), "CLIENT01");

    for (let i = 0; i < 5; i++) {
      manager.recordTurn({ turnNumber: i, intents: [] });
    }
    await manager.persist();
    expect(append.mock.calls[0][1]).toHaveLength(5);

    for (let i = 5; i < 10; i++) {
      manager.recordTurn({ turnNumber: i, intents: [] });
    }
    await manager.persist();
    expect(append.mock.calls[1][1].map((t) => t.turnNumber)).toEqual([
      5, 6, 7, 8, 9,
    ]);

    const loaded = await loadSave("GAME0001");
    expect(loaded?.turns.map((t) => t.turnNumber)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);

    manager.dispose();
  });

  it("fills skipped turns with empty turns on reload", async () => {
    const manager = new SaveManager();
    manager.begin(startInfo(), "CLIENT01");
    manager.recordTurn({ turnNumber: 0, intents: [] });
    manager.recordTurn({ turnNumber: 2, intents: [] });
    await manager.persist();

    const loaded = await loadSave("GAME0001");
    expect(loaded?.turns).toHaveLength(3);
    expect(loaded?.turns[1]).toEqual({ turnNumber: 1, intents: [] });

    manager.dispose();
  });

  it("attaches a core checkpoint that is covered by the recorded turns", async () => {
    const manager = new SaveManager();
    manager.begin(startInfo(), "CLIENT01");
    for (let i = 0; i < 10; i++) {
      manager.recordTurn({ turnNumber: i, intents: [] });
    }
    const checkpoint = { ticks: 5 } as unknown as GameCheckpoint;
    manager.setCheckpointProvider(() => checkpoint);
    await manager.persist();

    const loaded = await loadSave("GAME0001");
    expect((loaded?.checkpoint as GameCheckpoint | undefined)?.ticks).toBe(5);

    // A checkpoint ahead of the recorded history is dropped so the suffix can
    // never be incomplete.
    manager.setCheckpointProvider(
      () => ({ ticks: 999 }) as unknown as GameCheckpoint,
    );
    manager.recordTurn({ turnNumber: 10, intents: [] });
    await manager.persist();

    const reloaded = await loadSave("GAME0001");
    expect(reloaded?.checkpoint).toBeUndefined();

    manager.dispose();
  });
});
