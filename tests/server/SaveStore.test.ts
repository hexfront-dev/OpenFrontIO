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

  it("round-trips a checkpoint and drops it when a later save omits one", async () => {
    const store = new MemorySaveStore();
    await store.save(snapshot({ checkpoint: "cp-v1" }));
    expect((await store.load("abcd1234"))?.checkpoint).toBe("cp-v1");

    await store.save(snapshot({ savedAt: 3000 }));
    expect((await store.load("abcd1234"))?.checkpoint).toBeUndefined();
  });

  it("forgets the checkpoint on delete", async () => {
    const store = new MemorySaveStore();
    await store.save(snapshot({ checkpoint: "cp-v1" }));
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
    await writeFile(path.join(dir, "abcd1234.head.json"), "not json");
    expect(await store.load("abcd1234")).toBeNull();
  });

  it("appends only the delta across saves and reloads the full history", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "openfront-save-"));
    const store = new FilesystemSaveStore(dir);
    const turn = (turnNumber: number) => ({
      turnNumber,
      intents: [],
    });
    // First save writes turns 0..2; second appends only turn 3.
    await store.save(
      snapshot({
        turns: [turn(0), turn(1), turn(2)],
      }),
      0,
    );
    await store.save(
      snapshot({
        turns: [turn(0), turn(1), turn(2), turn(3)],
        savedAt: 3000,
      }),
      3,
    );

    const loaded = await new FilesystemSaveStore(dir).load("abcd1234");
    expect(loaded?.turns.map((t) => t.turnNumber)).toEqual([0, 1, 2, 3]);
    expect(loaded?.turns.length).toBe(4);
  });

  it("clamps a head that claims more turns than were appended", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "openfront-save-"));
    const store = new FilesystemSaveStore(dir);
    // Save with turns 0..1 but a head (numTurns=2) ahead of a history that only
    // got turn 0: load must still produce a dense, correctly-numbered history.
    await store.save(
      snapshot({
        turns: [{ turnNumber: 0, intents: [] }],
      }),
    );
    await writeFile(
      path.join(dir, "abcd1234.head.json"),
      JSON.stringify({
        version: SAVED_LOBBY_VERSION,
        gameID: "abcd1234",
        createdAt: 1000,
        creatorPersistentID: "creator-pid",
        gameConfig: snapshot().gameConfig,
        stage: "lobby",
        seats: [],
        savedAt: 2000,
        gitCommit: "DEV",
        numTurns: 2,
      }),
    );
    const loaded = await store.load("abcd1234");
    expect(loaded?.turns.map((t) => t.turnNumber)).toEqual([0, 1]);
    expect(loaded?.turns[1].intents).toEqual([]);
  });

  it("still reads a legacy single-blob save", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "openfront-save-"));
    const store = new FilesystemSaveStore(dir);
    const legacy = snapshot({ stage: "lobby" });
    const { gzipSync } = await import("node:zlib");
    await writeFile(
      path.join(dir, "abcd1234.json.gz"),
      gzipSync(Buffer.from(JSON.stringify(legacy), "utf8")),
    );
    const loaded = await store.load("abcd1234");
    expect(loaded?.gameID).toBe("abcd1234");
  });

  it("stores the checkpoint in a sidecar, not the JSON head", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "openfront-save-"));
    const store = new FilesystemSaveStore(dir);
    await store.save(snapshot({ checkpoint: "cp-v1" }));

    // The head on disk must stay free of the (potentially huge) blob.
    const headRaw = await (
      await import("node:fs/promises")
    ).readFile(path.join(dir, "abcd1234.head.json"), "utf8");
    expect(headRaw).not.toContain("cp-v1");

    const loaded = await new FilesystemSaveStore(dir).load("abcd1234");
    expect(loaded?.checkpoint).toBe("cp-v1");
  });

  it("removes a stale checkpoint sidecar when a later save omits it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "openfront-save-"));
    const store = new FilesystemSaveStore(dir);
    await store.save(snapshot({ checkpoint: "cp-v1" }));
    await store.save(snapshot({ savedAt: 3000 }));

    const loaded = await new FilesystemSaveStore(dir).load("abcd1234");
    expect(loaded?.checkpoint).toBeUndefined();
  });
});
