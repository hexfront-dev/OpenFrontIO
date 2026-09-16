import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteSave,
  listSaves,
  loadSave,
  MemorySaveBackend,
  saveGame,
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
  savedGameMetaFrom,
  SavedGameSchema,
} from "../src/core/Schemas";

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
});
