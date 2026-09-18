import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

    // 100 turns triggers the first checkpoint; async writes settle between ticks.
    await vi.advanceTimersByTimeAsync(100 * TURN_MS);

    const loaded = await saveStore.load(game.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.turns.length).toBeGreaterThanOrEqual(100);
  });
});
