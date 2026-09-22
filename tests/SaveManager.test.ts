import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../src/client/ClientEnv";
import { SaveManager } from "../src/client/SaveManager";
import {
  loadSave,
  MemorySaveBackend,
  setSaveBackend,
} from "../src/client/SaveStore";
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

  it("retains only the unpersisted tail and keeps counting", async () => {
    const manager = new SaveManager();
    manager.begin(startInfo(), "CLIENT01");

    for (let i = 0; i < 10; i++) {
      manager.recordTurn({ turnNumber: i, intents: [] });
    }
    await manager.persist();

    // The written prefix is dropped; only the count is retained.
    expect((manager as any).numTurns).toBe(10);
    expect((manager as any).turnsBase).toBe(10);
    expect((manager as any).turns).toHaveLength(0);

    for (let i = 10; i < 15; i++) {
      manager.recordTurn({ turnNumber: i, intents: [] });
    }
    expect((manager as any).turns).toHaveLength(5);
    await manager.persist();

    const loaded = await loadSave("GAME0001");
    expect(loaded?.turns.map((t) => t.turnNumber)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect((manager as any).numTurns).toBe(15);
    expect((manager as any).turnsBase).toBe(15);
    expect((manager as any).turns).toHaveLength(0);

    manager.dispose();
  });

  it("attaches a core checkpoint that is covered by the recorded turns", async () => {
    const manager = new SaveManager();
    manager.begin(startInfo(), "CLIENT01");
    for (let i = 0; i < 10; i++) {
      manager.recordTurn({ turnNumber: i, intents: [] });
    }
    const checkpointWire = "cp-wire";
    manager.setCheckpointProvider(() => ({ wire: checkpointWire, ticks: 5 }));
    await manager.persist();

    const loaded = await loadSave("GAME0001");
    expect(loaded?.checkpoint).toBe(checkpointWire);

    // A checkpoint ahead of the recorded history is dropped so the suffix can
    // never be incomplete.
    manager.setCheckpointProvider(() => ({ wire: "cp-late", ticks: 999 }));
    manager.recordTurn({ turnNumber: 10, intents: [] });
    await manager.persist();

    const reloaded = await loadSave("GAME0001");
    expect(reloaded?.checkpoint).toBeUndefined();

    manager.dispose();
  });

  it("force-persists a manual checkpoint even with no new turns", async () => {
    const manager = new SaveManager();
    manager.begin(startInfo(), "CLIENT01");
    manager.recordTurn({ turnNumber: 0, intents: [] });
    await manager.persist();

    // The save button fires a checkpoint with no new turn recorded; `force`
    // must still rewrite the head so it is stored.
    manager.setCheckpointProvider(() => ({ wire: "manual-wire", ticks: 0 }));
    await manager.persist(true);
    expect((await loadSave("GAME0001"))?.checkpoint).toBe("manual-wire");

    // A later non-forced autosave with nothing new must not drop it.
    await manager.persist();
    expect((await loadSave("GAME0001"))?.checkpoint).toBe("manual-wire");

    manager.dispose();
  });
});
