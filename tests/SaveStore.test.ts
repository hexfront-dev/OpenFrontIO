import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteSave,
  dropOversizedCheckpoint,
  listSaves,
  loadSave,
  MemorySaveBackend,
  requestPersistentStorage,
  resetPersistentStorageRequest,
  saveGame,
  saveGameProgress,
  setSaveBackend,
} from "../src/client/SaveStore";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../src/core/game/Game";
import {
  SAVED_GAME_VERSION,
  SavedGame,
  savedGameHeadFrom,
  savedGameMetaFrom,
  SavedGameSchema,
  Turn,
} from "../src/core/Schemas";

class QuotaOnceBackend extends MemorySaveBackend {
  public failSaveId: string | null = null;
  private failed = false;

  override async appendTurns(saveId: string, turns: Turn[]): Promise<void> {
    if (saveId === this.failSaveId && !this.failed) {
      this.failed = true;
      const error = new Error("quota exceeded");
      error.name = "QuotaExceededError";
      throw error;
    }
    await super.appendTurns(saveId, turns);
  }
}

function makeSave(overrides: Partial<SavedGame> = {}): SavedGame {
  return {
    version: SAVED_GAME_VERSION,
    saveId: "SAVE0001",
    gameID: "GAME0001",
    label: "Asia · Alice",
    savedAt: 1_700_000_000_000,
    gitCommit: "DEV",
    myClientID: "CLIENT01",
    startInfo: {
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
      players: [
        { clientID: "CLIENT01", username: "Alice", clanTag: null },
        { clientID: "CLIENT02", username: "Bob", clanTag: null },
      ],
    },
    turns: [
      { turnNumber: 0, intents: [] },
      { turnNumber: 1, intents: [] },
    ],
    ...overrides,
  };
}

describe("SaveStore", () => {
  beforeEach(() => {
    setSaveBackend(new MemorySaveBackend());
    resetPersistentStorageRequest();
    vi.unstubAllGlobals();
  });

  it("round-trips a save and its metadata", async () => {
    const save = makeSave();
    await saveGame(save);

    const loaded = await loadSave(save.saveId);
    expect(loaded).toEqual(save);

    const metas = await listSaves();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      saveId: save.saveId,
      gameID: save.gameID,
      numTurns: 2,
      playerCount: 2,
      gameMap: GameMapType.Asia,
      gameType: GameType.Singleplayer,
      playerNames: ["Alice", "Bob"],
    });
  });

  it("lists newest saves first", async () => {
    await saveGame(makeSave({ saveId: "SAVE0001", savedAt: 1000 }));
    await saveGame(makeSave({ saveId: "SAVE0002", savedAt: 2000 }));

    const metas = await listSaves();
    expect(metas.map((m) => m.saveId)).toEqual(["SAVE0002", "SAVE0001"]);
  });

  it("overwrites an existing save with the same id", async () => {
    await saveGame(makeSave({ savedAt: 1000, turns: [] }));
    await saveGame(
      makeSave({ savedAt: 2000, turns: [{ turnNumber: 0, intents: [] }] }),
    );

    const metas = await listSaves();
    expect(metas).toHaveLength(1);
    expect(metas[0].numTurns).toBe(1);
    expect(metas[0].savedAt).toBe(2000);
  });

  it("deletes a save", async () => {
    await saveGame(makeSave());
    await deleteSave("SAVE0001");

    expect(await loadSave("SAVE0001")).toBeUndefined();
    expect(await listSaves()).toHaveLength(0);
  });

  it("caps the number of stored saves, dropping the oldest", async () => {
    for (let i = 0; i < 32; i++) {
      await saveGame(
        makeSave({
          saveId: `SAVE${String(i).padStart(4, "0")}`,
          savedAt: 1000 + i,
        }),
      );
    }
    const metas = await listSaves();
    expect(metas).toHaveLength(30);
    expect(metas.some((m) => m.saveId === "SAVE0000")).toBe(false);
    expect(metas.some((m) => m.saveId === "SAVE0001")).toBe(false);
    expect(metas.some((m) => m.saveId === "SAVE0031")).toBe(true);
  });

  it("rejects a save written under a different schema version", () => {
    const result = SavedGameSchema.safeParse({
      ...makeSave(),
      version: "v9.9.9",
    });
    expect(result.success).toBe(false);
  });

  it("derives metadata from a save", () => {
    const meta = savedGameMetaFrom(makeSave());
    expect(meta.label).toBe("Asia · Alice");
    expect(meta.numTurns).toBe(2);
    expect(meta.playerCount).toBe(2);
  });

  it("round-trips a save written incrementally", async () => {
    const head = savedGameHeadFrom(makeSave({ turns: [] }));
    await saveGameProgress(
      { ...head, numTurns: 1 },
      [{ turnNumber: 0, intents: [] }],
      true,
    );
    await saveGameProgress(
      { ...head, numTurns: 2, savedAt: 1_700_000_001_000 },
      [{ turnNumber: 1, intents: [] }],
      false,
    );

    const loaded = await loadSave("SAVE0001");
    expect(loaded?.turns.map((t) => t.turnNumber)).toEqual([0, 1]);
    const metas = await listSaves();
    expect(metas[0].numTurns).toBe(2);
    expect(metas[0].savedAt).toBe(1_700_000_001_000);
  });

  it("appends only the delta on each progress write", async () => {
    const backend = new MemorySaveBackend();
    setSaveBackend(backend);
    const append = vi.spyOn(backend, "appendTurns");
    const head = savedGameHeadFrom(makeSave({ turns: [] }));

    await saveGameProgress(
      { ...head, numTurns: 25 },
      Array.from({ length: 25 }, (_, i) => ({ turnNumber: i, intents: [] })),
      true,
    );
    await saveGameProgress(
      { ...head, numTurns: 30, savedAt: 1_700_000_002_000 },
      Array.from({ length: 5 }, (_, i) => ({
        turnNumber: 25 + i,
        intents: [],
      })),
      false,
    );

    expect(append.mock.calls[0][1]).toHaveLength(25);
    expect(append.mock.calls[1][1]).toHaveLength(5);
    expect((await loadSave("SAVE0001"))?.turns).toHaveLength(30);
  });

  it("clears stale turns when a progress write resets the save", async () => {
    const backend = new MemorySaveBackend();
    setSaveBackend(backend);
    const head = savedGameHeadFrom(makeSave({ turns: [] }));

    await saveGameProgress(
      { ...head, numTurns: 3 },
      Array.from({ length: 3 }, (_, i) => ({ turnNumber: i, intents: [] })),
      true,
    );
    await saveGameProgress(
      { ...head, numTurns: 1, savedAt: 1_700_000_003_000 },
      [{ turnNumber: 0, intents: [] }],
      true,
    );

    expect((await loadSave("SAVE0001"))?.turns).toHaveLength(1);
  });
});

describe("SaveStore storage lifecycle (Phase 6)", () => {
  beforeEach(() => {
    setSaveBackend(new MemorySaveBackend());
    resetPersistentStorageRequest();
    vi.unstubAllGlobals();
  });

  it("drops an oversized checkpoint but keeps the turn history", () => {
    const head = savedGameHeadFrom(makeSave({ checkpoint: "cp" }));
    const turns = makeSave().turns;

    expect(dropOversizedCheckpoint(head, turns, 1).checkpoint).toBeUndefined();
    // A cap large enough keeps the checkpoint.
    expect(dropOversizedCheckpoint(head, turns, 10_000_000).checkpoint).toBe(
      "cp",
    );
  });

  it("requests persistent storage once", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("navigator", {
      storage: {
        persist,
        estimate: vi.fn().mockResolvedValue({ usage: 0 }),
      },
    });
    resetPersistentStorageRequest();

    expect(await requestPersistentStorage()).toBe(true);
    await requestPersistentStorage();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest save and retries when the quota is exceeded", async () => {
    const backend = new QuotaOnceBackend();
    setSaveBackend(backend);
    await saveGame(makeSave({ saveId: "SAVE0001", savedAt: 1000 }));
    await saveGame(makeSave({ saveId: "SAVE0002", savedAt: 2000 }));

    backend.failSaveId = "SAVE0003";
    await saveGame(makeSave({ saveId: "SAVE0003", savedAt: 3000 }));

    const metas = await listSaves();
    expect(metas.map((m) => m.saveId).sort()).toEqual(["SAVE0002", "SAVE0003"]);
    expect(await loadSave("SAVE0003")).toBeDefined();
  });

  it("evicts saves when the origin exceeds the byte budget", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        persist: vi.fn().mockResolvedValue(true),
        estimate: vi.fn().mockResolvedValue({
          usage: Number.MAX_SAFE_INTEGER,
        }),
      },
    });
    await saveGame(makeSave({ saveId: "SAVE0001", savedAt: 1000 }));
    await saveGame(makeSave({ saveId: "SAVE0002", savedAt: 2000 }));
    await saveGame(makeSave({ saveId: "SAVE0003", savedAt: 3000 }));

    const metas = await listSaves();
    expect(metas).toHaveLength(1);
    expect(metas[0].saveId).toBe("SAVE0003");
  });
});
