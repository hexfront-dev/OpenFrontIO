import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT_VERSION, GameCheckpoint } from "../../src/core/Checkpoint";
import { encodeCheckpoint } from "../../src/core/CheckpointCodec";
import { GameType } from "../../src/core/game/Game";
import { SavedLobbySchema } from "../../src/core/Schemas";
import { createGameWireContext } from "../../src/core/ZbinWire";
import { GamePhase, GameServer } from "../../src/server/GameServer";
import { MemorySaveStore } from "../../src/server/SaveStore";
import {
  cid,
  makeClient,
  makeGame,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";

const T0 = 1_700_000_000_000;
const TURN_MS = 100;
const HOUR = 60 * 60 * 1000;

describe("GameServer snapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("refuses to snapshot public games and games without a creator", () => {
    expect(makeGame().snapshot()).toBeNull();
    expect(
      makeGame({ creatorPersistentID: "host-pid" }).snapshot(),
    ).not.toBeNull();
    expect(
      makeGame({
        creatorPersistentID: "host-pid",
        config: { gameType: GameType.Public },
      }).snapshot(),
    ).toBeNull();
  });

  it("round-trips a started game through the schema", () => {
    const game = makeGame({ creatorPersistentID: "host-pid" });
    game.joinClient(
      makeClient({ clientID: cid("host"), persistentID: "host-pid" }),
    );
    game.joinClient(
      makeClient({ clientID: cid("p2"), persistentID: "p2-pid" }),
    );
    startGame(game);
    vi.advanceTimersByTime(3 * TURN_MS);

    const snap = game.snapshot()!;
    expect(SavedLobbySchema.safeParse(snap).success).toBe(true);
    expect(snap.stage).toBe("started");
    expect(snap.turns.length).toBeGreaterThan(0);
    expect(snap.gameStartInfo?.players.map((p) => p.clientID)).toEqual([
      cid("host"),
      cid("p2"),
    ]);
    expect(snap.seats.map((s) => s.clientID)).toEqual([cid("host"), cid("p2")]);
  });
});

describe("GameServer restore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function startedSnapshot() {
    const game = makeGame({ creatorPersistentID: "host-pid" });
    game.joinClient(
      makeClient({ clientID: cid("host"), persistentID: "host-pid" }),
    );
    game.joinClient(
      makeClient({ clientID: cid("p2"), persistentID: "p2-pid" }),
    );
    startGame(game);
    vi.advanceTimersByTime(3 * TURN_MS);
    return game.snapshot()!;
  }

  it("rebuilds a live started game with its history and seats", () => {
    const snap = startedSnapshot();
    const restored = makeGame({
      restore: snap,
      creatorPersistentID: "host-pid",
    });

    expect(restored.isRestored()).toBe(true);
    expect(restored.phase()).toBe(GamePhase.Active);
    expect(restored.claimableSeats().map((s) => s.clientID)).toEqual([
      cid("host"),
      cid("p2"),
    ]);
    expect(restored.claimableSeats().every((s) => !s.claimed)).toBe(true);
  });

  it("reconnects an original player straight to their saved nation", () => {
    const snap = startedSnapshot();
    const restored = makeGame({ restore: snap });
    const ws = mockWsOf(
      makeClient({ clientID: cid("throw"), persistentID: "x" }),
    );

    expect(restored.rejoinClient(ws as any, "p2-pid", 0)).toBe(true);
    expect(restored.getClientIdForPersistentId("p2-pid")).toBe(cid("p2"));
    expect(restored.numClients()).toBe(1);
  });

  it("lets a new player claim an original human nation after a start countdown", () => {
    const snap = startedSnapshot();
    const restored = makeGame({ restore: snap });
    const joiner = makeClient({
      clientID: cid("new"),
      persistentID: "new-pid",
    });

    expect(restored.joinClient(joiner, cid("p2"))).toBe("joined");
    expect(joiner.clientID).toBe(cid("p2"));
    expect(joiner.spectator).toBe(false);

    const ctx = createGameWireContext(snap.gameStartInfo!.players);
    // The resumed game does not start instantly: it holds a start countdown so
    // late players still have time to pick a nation.
    const beforeStart = mockWsOf(joiner).sent(ctx);
    expect(beforeStart.some((m) => m.type === "start")).toBe(false);
    const prestart = beforeStart.find((m) => m.type === "prestart");
    expect(prestart?.type === "prestart" && prestart.startsAt).toBeGreaterThan(
      Date.now(),
    );
    expect(restored.isResumeCountingDown()).toBe(true);

    // Once the countdown elapses the saved history is delivered and play
    // resumes with the claimed nation.
    vi.advanceTimersByTime(GameServer.RESUME_START_DELAY_MS + 10);
    const start = mockWsOf(joiner)
      .sent(ctx)
      .find((m) => m.type === "start");
    expect(start?.type === "start" && start.myClientID).toBe(cid("p2"));
    expect(restored.isResumeCountingDown()).toBe(false);

    // The claimed seat is no longer offered to anyone else.
    expect(restored.claimableSeats("other-pid")).toContainEqual({
      clientID: cid("p2"),
      username: expect.any(String),
      claimed: true,
    });
  });

  it("starts a restored game immediately once its countdown has elapsed", () => {
    const snap = startedSnapshot();
    const restored = makeGame({ restore: snap });
    const ctx = createGameWireContext(snap.gameStartInfo!.players);

    const first = makeClient({ clientID: cid("first"), persistentID: "f-pid" });
    expect(restored.joinClient(first, cid("p2"))).toBe("joined");
    vi.advanceTimersByTime(GameServer.RESUME_START_DELAY_MS + 10);
    expect(restored.isResumeCountingDown()).toBe(false);

    // A late joiner after the countdown goes straight into the running game.
    const late = makeClient({ clientID: cid("late"), persistentID: "l-pid" });
    expect(restored.joinClient(late, cid("host"))).toBe("joined");
    const start = mockWsOf(late)
      .sent(ctx)
      .find((m) => m.type === "start");
    expect(start?.type === "start" && start.myClientID).toBe(cid("host"));
  });

  it("cannot claim an AI nation or a seat someone already holds", () => {
    const snap = startedSnapshot();
    const restored = makeGame({ restore: snap });

    // No saved seat by this clientID -> falls back to spectating.
    const stranger = makeClient({
      clientID: cid("str"),
      persistentID: "str-pid",
    });
    expect(restored.joinClient(stranger, cid("ai"))).toBe("joined");
    expect(stranger.clientID).toBe(cid("str"));
    expect(stranger.spectator).toBe(true);

    // First claimant wins; the second is a spectator.
    const first = makeClient({ clientID: cid("first"), persistentID: "f-pid" });
    expect(restored.joinClient(first, cid("p2"))).toBe("joined");
    expect(first.spectator).toBe(false);
    const second = makeClient({ clientID: cid("sec"), persistentID: "s-pid" });
    expect(restored.joinClient(second, cid("p2"))).toBe("joined");
    expect(second.spectator).toBe(true);
  });

  it("restores an unstarted lobby that new players can join as players", () => {
    const lobby = makeGame({ creatorPersistentID: "host-pid" });
    lobby.joinClient(
      makeClient({ clientID: cid("host"), persistentID: "host-pid" }),
    );
    const snap = lobby.snapshot()!;
    expect(snap.stage).toBe("lobby");
    expect(snap.turns).toEqual([]);

    const restored = makeGame({ restore: snap });
    expect(restored.phase()).toBe(GamePhase.Lobby);

    const newcomer = makeClient({
      clientID: cid("new"),
      persistentID: "new-pid",
    });
    expect(restored.joinClient(newcomer)).toBe("joined");
    expect(newcomer.spectator).toBe(false);
  });

  it("gives an old save a fresh max-duration window (trap 1)", () => {
    const lobby = makeGame({
      creatorPersistentID: "host-pid",
      createdAt: T0 - 2 * HOUR,
    });
    lobby.joinClient(
      makeClient({ clientID: cid("host"), persistentID: "host-pid" }),
    );
    const snap = lobby.snapshot()!;

    // The original game would be Finished if it were past the 3h cap.
    expect(snap.createdAt).toBeLessThan(T0 - HOUR);
    const restored = makeGame({ restore: snap, createdAt: snap.createdAt });
    expect(restored.phase()).toBe(GamePhase.Lobby);
  });
});

describe("GameServer autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("checkpoints a started private game every SAVE_EVERY_TURNS turns", async () => {
    const saveStore = new MemorySaveStore();
    const game = makeGame({
      creatorPersistentID: "host-pid",
      deps: { saveStore },
    });
    game.joinClient(
      makeClient({ clientID: cid("host"), persistentID: "host-pid" }),
    );
    startGame(game);

    // 25 turns triggers the first checkpoint; async writes settle between ticks.
    await vi.advanceTimersByTimeAsync(25 * TURN_MS);

    const loaded = await saveStore.load(game.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.turns.length).toBeGreaterThanOrEqual(25);
  });
});

describe("GameServer checkpoint resume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // A minimal structurally-valid checkpoint; the server only decodes it to
  // read `ticks` and to run isGameCheckpoint, so no real simulation state is
  // needed. Encoding with the real codec exercises the same path a host uses.
  function checkpointJson(ticks: number): string {
    return encodeCheckpoint({
      version: CHECKPOINT_VERSION,
      ticks,
      players: [],
      units: [],
      map: {},
    } as unknown as GameCheckpoint);
  }

  function startedGame(saveStore: MemorySaveStore) {
    const game = makeGame({
      creatorPersistentID: "host-pid",
      deps: { saveStore },
    });
    const host = makeClient({
      clientID: cid("host"),
      persistentID: "host-pid",
    });
    const p2 = makeClient({ clientID: cid("p2"), persistentID: "p2-pid" });
    game.joinClient(host);
    game.joinClient(p2);
    startGame(game);
    return { game, host, p2 };
  }

  it("stores a host checkpoint and serves only the suffix on resume", async () => {
    const saveStore = new MemorySaveStore();
    const { game, host } = startedGame(saveStore);
    await vi.advanceTimersByTimeAsync(10 * TURN_MS);
    expect(game.snapshot()!.turns.length).toBe(10);

    const checkpoint = checkpointJson(5);
    await mockWsOf(host).emit({ type: "checkpoint", checkpoint });
    await vi.advanceTimersByTimeAsync(0);
    const snap = game.snapshot()!;
    expect(snap.checkpoint).toBe(checkpoint);
    await saveStore.save(snap, 0);

    const loaded = (await saveStore.load(game.id))!;
    const restored = makeGame({ restore: loaded });
    const joiner = makeClient({
      clientID: cid("new"),
      persistentID: "new-pid",
    });
    expect(restored.joinClient(joiner, cid("p2"))).toBe("joined");
    vi.advanceTimersByTime(GameServer.RESUME_START_DELAY_MS + 10);

    const ctx = createGameWireContext(loaded.gameStartInfo!.players);
    const start = mockWsOf(joiner)
      .sent(ctx)
      .find((m) => m.type === "start");
    expect(start?.type).toBe("start");
    if (start?.type !== "start") return;
    expect(start.checkpoint).toBe(checkpoint);
    // Only turns 5..9, not the whole 0..9 history.
    expect(start.turns[0].turnNumber).toBe(5);
    expect(start.turns.map((t) => t.turnNumber)).toEqual([5, 6, 7, 8, 9]);
  });

  it("ignores a checkpoint from a non-creator", async () => {
    const saveStore = new MemorySaveStore();
    const { game, p2 } = startedGame(saveStore);
    await vi.advanceTimersByTimeAsync(10 * TURN_MS);

    // p2 is in the game but not the creator; its upload must be dropped.
    await mockWsOf(p2).emit({
      type: "checkpoint",
      checkpoint: checkpointJson(4),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(game.snapshot()!.checkpoint).toBeUndefined();
  });
});

// Phase 4: a long resume backlog is delivered as a small `start` plus a stream
// of `turn_chunk` frames instead of one oversized start frame.
describe("GameServer chunked resume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("streams a long backlog in chunks", async () => {
    const game = makeGame({ creatorPersistentID: "host-pid" });
    const host = makeClient({
      clientID: cid("host"),
      persistentID: "host-pid",
    });
    const p2 = makeClient({ clientID: cid("p2"), persistentID: "p2-pid" });
    game.joinClient(host);
    game.joinClient(p2);
    startGame(game);
    await vi.advanceTimersByTimeAsync(1200 * TURN_MS);
    const snap = game.snapshot()!;
    const total = snap.turns.length;
    expect(total).toBeGreaterThanOrEqual(1200);

    // Parse first: `snapshot()` aliases the live server turn array, which keeps
    // growing while the restored game waits out its countdown.
    const restored = makeGame({ restore: SavedLobbySchema.parse(snap) });
    const joiner = makeClient({
      clientID: cid("new"),
      persistentID: "new-pid",
    });
    expect(restored.joinClient(joiner, cid("p2"))).toBe("joined");
    // The restored game holds a start countdown before sending history.
    vi.advanceTimersByTime(GameServer.RESUME_START_DELAY_MS + 1);
    // Flush the chunk pump's timers.
    await vi.advanceTimersByTimeAsync(50);

    const ctx = createGameWireContext(snap.gameStartInfo!.players);
    const frames = mockWsOf(joiner).sent(ctx);
    const start = frames.find((m) => m.type === "start");
    expect(start?.type).toBe("start");
    if (start?.type !== "start") return;

    expect(start.chunkSize).toBe(GameServer.RESUME_CHUNK_TURNS);
    expect(start.numTurns).toBe(total);
    expect(start.turns).toHaveLength(GameServer.RESUME_CHUNK_TURNS);

    const chunks = frames.filter((m) => m.type === "turn_chunk");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      if (chunk.type !== "turn_chunk") continue;
      expect(chunk.turns.length).toBeLessThanOrEqual(
        GameServer.RESUME_CHUNK_TURNS,
      );
    }
    // Exactly the last chunk is marked final.
    const finalFlags = chunks.map((c) =>
      c.type === "turn_chunk" ? c.final : true,
    );
    expect(finalFlags.filter((f) => f)).toHaveLength(1);
    expect(finalFlags[finalFlags.length - 1]).toBe(true);

    // The first chunk plus every streamed chunk reconstructs the full dense
    // history, in order, with nothing mangled by the wire codec.
    const streamed = chunks.flatMap((c) =>
      c.type === "turn_chunk" ? c.turns : [],
    );
    const all = [...start.turns, ...streamed];
    expect(all).toHaveLength(total);
    expect(all.map((t) => t.turnNumber)).toEqual(
      Array.from({ length: total }, (_, i) => i),
    );
  });
});
