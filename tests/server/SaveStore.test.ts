import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SAVED_LOBBY_VERSION,
  SavedLobby,
  SavedLobbySchema,
} from "../../src/core/Schemas";
import {
  FilesystemSaveStore,
  MemorySaveStore,
} from "../../src/server/SaveStore";
import { testGameConfig } from "../util/Wire";

function snapshot(overrides: Partial<SavedLobby> = {}): SavedLobby {
  return SavedLobbySchema.parse({
    version: SAVED_LOBBY_VERSION,
    gameID: "abcd1234",
    createdAt: 1000,
    creatorPersistentID: "creator-pid",
    gameConfig: testGameConfig(),
    stage: "lobby",
    seats: [],
    turns: [],
    savedAt: 2000,
    gitCommit: "DEV",
    ...overrides,
  });
}

describe("MemorySaveStore", () => {
  it("round-trips a snapshot", async () => {
    const store = new MemorySaveStore();
    await store.save(snapshot());
    const loaded = await store.load("abcd1234");
    expect(loaded?.gameID).toBe("abcd1234");
    expect(loaded?.creatorPersistentID).toBe("creator-pid");
  });

  it("returns null for an unknown game", async () => {
    const store = new MemorySaveStore();
    expect(await store.load("zzzz9999")).toBeNull();
  });

  it("lists only the creator's saves, newest first", async () => {
    const store = new MemorySaveStore();
    await store.save(
      snapshot({ gameID: "aaaa1111", savedAt: 100, creatorPersistentID: "me" }),
    );
    await store.save(
      snapshot({ gameID: "bbbb2222", savedAt: 300, creatorPersistentID: "me" }),
    );
    await store.save(
      snapshot({
        gameID: "cccc3333",
        savedAt: 200,
        creatorPersistentID: "you",
      }),
    );
    const metas = await store.list("me");
    expect(metas.map((m) => m.gameID)).toEqual(["bbbb2222", "aaaa1111"]);
  });

  it("deletes a save", async () => {
    const store = new MemorySaveStore();
    await store.save(snapshot());
    await store.delete("abcd1234");
    expect(await store.load("abcd1234")).toBeNull();
  });
});

describe("FilesystemSaveStore", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("round-trips a gzipped snapshot on disk", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "openfront-save-"));
    const store = new FilesystemSaveStore(dir);
    await store.save(snapshot({ stage: "lobby" }));

    // Re-open with a fresh instance to prove it really hit the disk.
    const loaded = await new FilesystemSaveStore(dir).load("abcd1234");
    expect(loaded?.gameID).toBe("abcd1234");
    expect(loaded?.stage).toBe("lobby");
  });

  it("lists meta without decompressing and filters by creator", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "openfront-save-"));
    const store = new FilesystemSaveStore(dir);
    await store.save(
      snapshot({ gameID: "aaaa1111", savedAt: 100, creatorPersistentID: "me" }),
    );
    await store.save(
      snapshot({
        gameID: "bbbb2222",
        savedAt: 300,
        creatorPersistentID: "you",
      }),
    );
    const metas = await store.list("me");
    expect(metas).toHaveLength(1);
    expect(metas[0].gameID).toBe("aaaa1111");
  });

  it("returns null for a missing save and empty list for a missing dir", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "openfront-save-"));
    const store = new FilesystemSaveStore(path.join(dir, "does-not-exist"));
    expect(await store.load("abcd1234")).toBeNull();
    expect(await store.list("me")).toEqual([]);
  });

  it("rejects an invalid game id rather than escaping the directory", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "openfront-save-"));
    const store = new FilesystemSaveStore(dir);
    await expect(store.load("../escape")).rejects.toThrow();
  });

  it("treats a corrupt payload as missing rather than throwing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "openfront-save-"));
    const store = new FilesystemSaveStore(dir);
    await store.save(snapshot());
    await writeFile(path.join(dir, "abcd1234.json.gz"), "not gzip");
    expect(await store.load("abcd1234")).toBeNull();
  });
});
