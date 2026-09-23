import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT_VERSION, GameCheckpoint } from "../../src/core/Checkpoint";
import {
  decodeCheckpointWire,
  encodeCheckpoint,
  encodeCheckpointGzip,
} from "../../src/core/CheckpointCodec";
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

  // A save nobody has rejoined yet is waiting to be reopened as a private
  // lobby. The normal empty-client warmup would retire it ~30s after Resume,
  // before the original players drop back in, so a restored game must stay
  // resumable until someone joins (or the max-duration cap retires it).
  it("keeps a restored save alive while it waits to be reopened", () => {
    const snap = startedSnapshot();
    const restored = makeGame({ restore: snap });
    expect(restored.phase()).toBe(GamePhase.Active);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(restored.isResumeCountingDown()).toBe(true);
    expect(restored.phase()).toBe(GamePhase.Active);
  });

  // A restored lobby starts through the normal host flow (a Start button),
  // not through the resume countdown. Once it is running, later joins must
  // resume play immediately rather than trigger a second countdown.
  it("starts a restored lobby normally without re-arming the resume countdown", () => {
    const lobby = makeGame({ creatorPersistentID: "host-pid" });
    lobby.joinClient(
      makeClient({ clientID: cid("host"), persistentID: "host-pid" }),
    );
    const snap = lobby.snapshot()!;
    expect(snap.stage).toBe("lobby");

    const restored = makeGame({ restore: snap });
    // The original host reconnects to the restored lobby (their saved seat).
    const hostWs = mockWsOf(
      makeClient({ clientID: cid("tmp"), persistentID: "x" }),
    );
    expect(restored.rejoinClient(hostWs as any, "host-pid", 0)).toBe(true);

    startGame(restored);
    expect(restored.isResumeCountingDown()).toBe(false);

    const late = makeClient({
      clientID: cid("late"),
      persistentID: "late-pid",
    });
    expect(restored.joinClient(late)).toBe("joined");
    const ctx = createGameWireContext(
      restored.snapshot()!.gameStartInfo!.players,
    );
    const start = mockWsOf(late)
      .sent(ctx)
      .find((m) => m.type === "start");
    expect(start?.type).toBe("start");
    expect(restored.isResumeCountingDown()).toBe(false);
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

describe("GameServer creator-leave save", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("saves a started private game only when the creator leaves", async () => {
    const saveStore = new MemorySaveStore();
    const game = makeGame({
      creatorPersistentID: "host-pid",
      deps: { saveStore },
    });
    const host = makeClient({
      clientID: cid("host"),
      persistentID: "host-pid",
    });
    game.joinClient(host);
    startGame(game);

    // There is no periodic autosave: 25 turns with the creator present writes
    // nothing.
    await vi.advanceTimersByTimeAsync(25 * TURN_MS);
    expect(await saveStore.load(game.id)).toBeNull();

    // The creator's socket closing is the save trigger.
    await mockWsOf(host).trigger("close");
    await vi.advanceTimersByTimeAsync(0);

    const loaded = await saveStore.load(game.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.stage).toBe("started");
    expect(loaded!.turns.length).toBeGreaterThanOrEqual(25);
  });

  it("saves an unstarted lobby when the creator leaves", async () => {
    const saveStore = new MemorySaveStore();
    const game = makeGame({
      creatorPersistentID: "host-pid",
      deps: { saveStore },
    });
    const host = makeClient({
      clientID: cid("host"),
      persistentID: "host-pid",
    });
    game.joinClient(host);

    await mockWsOf(host).trigger("close");
    await vi.advanceTimersByTimeAsync(0);

    const loaded = await saveStore.load(game.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.stage).toBe("lobby");
    expect(loaded!.seats.map((s) => s.clientID)).toEqual([cid("host")]);
  });

  it("flushes a live private game on shutdown without a creator leave", async () => {
    const saveStore = new MemorySaveStore();
    const game = makeGame({
      creatorPersistentID: "host-pid",
      deps: { saveStore },
    });
    game.joinClient(
      makeClient({ clientID: cid("host"), persistentID: "host-pid" }),
    );
    startGame(game);
    await vi.advanceTimersByTimeAsync(25 * TURN_MS);

    // The creator is still connected, so no creator-leave save has run.
    expect(await saveStore.load(game.id)).toBeNull();

    await game.flushSave();

    const loaded = await saveStore.load(game.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.turns.length).toBeGreaterThanOrEqual(25);
  });

  it("does not save when a non-creator leaves", async () => {
    const saveStore = new MemorySaveStore();
    const game = makeGame({
      creatorPersistentID: "host-pid",
      deps: { saveStore },
    });
    game.joinClient(
      makeClient({ clientID: cid("host"), persistentID: "host-pid" }),
    );
    const p2 = makeClient({ clientID: cid("p2"), persistentID: "p2-pid" });
    game.joinClient(p2);
    startGame(game);
    await vi.advanceTimersByTimeAsync(25 * TURN_MS);

    await mockWsOf(p2).trigger("close");
    await vi.advanceTimersByTimeAsync(0);

    expect(await saveStore.load(game.id)).toBeNull();
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

  // The in-game Save button uploads a checkpoint; that is an explicit
  // "make this resumable" request and must write a server save immediately,
  // not wait for the creator to leave. Without this the host's server-save
  // list stays empty and the private lobby can never be reopened.
  it("persists an on-demand save when the host uploads a checkpoint", async () => {
    const saveStore = new MemorySaveStore();
    const { game, host } = startedGame(saveStore);
    await vi.advanceTimersByTimeAsync(10 * TURN_MS);

    expect(await saveStore.list("host-pid")).toEqual([]);

    const checkpoint = checkpointJson(5);
    await mockWsOf(host).emit({ type: "checkpoint", checkpoint });
    await game.whenCheckpointUploadsSettled();
    await vi.advanceTimersByTimeAsync(0);

    const metas = await saveStore.list("host-pid");
    expect(metas.map((m) => m.gameID)).toEqual([game.id]);
    expect(metas[0].stage).toBe("started");
    const loaded = (await saveStore.load(game.id))!;
    expect(loaded.checkpoint).toBe(checkpoint);
    expect(loaded.checkpointTurn).toBe(5);
    expect(loaded.turns.length).toBe(10);
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

// Phase 7: a gzip-compressed checkpoint too large for one frame is uploaded in
// `checkpoint_chunk` frames, reassembled server-side under caps, and stored as
// the joined `gz:` string (with its turn) for resume.
describe("GameServer compressed checkpoint upload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function minimalCheckpoint(ticks: number): GameCheckpoint {
    return {
      version: CHECKPOINT_VERSION,
      ticks,
      players: [],
      units: [],
      map: {},
    } as unknown as GameCheckpoint;
  }

  function startedGame() {
    const game = makeGame({ creatorPersistentID: "host-pid" });
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

  async function uploadChunks(
    host: ReturnType<typeof makeClient>,
    uploadId: string,
    wire: string,
    chunkChars = 16,
  ): Promise<void> {
    const total = Math.ceil(wire.length / chunkChars);
    for (let seq = 0; seq < total; seq++) {
      await mockWsOf(host).emit({
        type: "checkpoint_chunk",
        uploadId,
        seq,
        total,
        encoding: "gzip",
        data: wire.slice(seq * chunkChars, (seq + 1) * chunkChars),
      });
    }
  }

  it("reassembles a chunked gzip checkpoint and records its turn", async () => {
    const { game, host } = startedGame();
    await vi.advanceTimersByTimeAsync(10 * TURN_MS);

    const wire = await encodeCheckpointGzip(minimalCheckpoint(5));
    await uploadChunks(host, "up-1", wire);
    // The gzip decode runs off the socket's await chain.
    await game.whenCheckpointUploadsSettled();

    const snap = game.snapshot()!;
    expect(snap.checkpoint).toBe(wire);
    expect(snap.checkpointTurn).toBe(5);
    // The stored payload is a real gzip checkpoint, not a mangled join.
    expect((await decodeCheckpointWire(snap.checkpoint!))?.ticks).toBe(5);
  });

  it("restores a gz checkpoint without a synchronous decode", async () => {
    const { game, host } = startedGame();
    await vi.advanceTimersByTimeAsync(10 * TURN_MS);
    const wire = await encodeCheckpointGzip(minimalCheckpoint(4));
    await uploadChunks(host, "up-1", wire);
    await game.whenCheckpointUploadsSettled();

    const snap = SavedLobbySchema.parse(game.snapshot());
    const restored = makeGame({ restore: snap });
    expect(restored.snapshot()?.checkpoint).toBe(wire);
    expect(restored.snapshot()?.checkpointTurn).toBe(4);
  });

  it("ignores an upload from a non-creator", async () => {
    const { game, p2 } = startedGame();
    await vi.advanceTimersByTimeAsync(10 * TURN_MS);
    const wire = await encodeCheckpointGzip(minimalCheckpoint(5));
    await uploadChunks(p2, "up-1", wire);
    await game.whenCheckpointUploadsSettled();
    expect(game.snapshot()!.checkpoint).toBeUndefined();
  });

  it("rejects an upload with too many chunks", async () => {
    const { game, host } = startedGame();
    await vi.advanceTimersByTimeAsync(10 * TURN_MS);
    await mockWsOf(host).emit({
      type: "checkpoint_chunk",
      uploadId: "up-1",
      seq: 0,
      total: GameServer.MAX_CHECKPOINT_UPLOAD_CHUNKS + 1,
      encoding: "gzip",
      data: "AAAA",
    });
    expect(game.snapshot()!.checkpoint).toBeUndefined();
  });

  it("rate limits new uploads per minute", async () => {
    const original = GameServer.MAX_CHECKPOINT_UPLOADS_PER_MINUTE;
    GameServer.MAX_CHECKPOINT_UPLOADS_PER_MINUTE = 1;
    try {
      const { game, host } = startedGame();
      await vi.advanceTimersByTimeAsync(10 * TURN_MS);
      await uploadChunks(
        host,
        "up-1",
        await encodeCheckpointGzip(minimalCheckpoint(3)),
      );
      await uploadChunks(
        host,
        "up-2",
        await encodeCheckpointGzip(minimalCheckpoint(6)),
      );
      await game.whenCheckpointUploadsSettled();
      // The second upload is over the per-minute budget and is dropped.
      expect(game.snapshot()!.checkpointTurn).toBe(3);
    } finally {
      GameServer.MAX_CHECKPOINT_UPLOADS_PER_MINUTE = original;
    }
  });
});
