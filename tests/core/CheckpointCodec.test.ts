import { describe, expect, it } from "vitest";
import { CHECKPOINT_VERSION, GameCheckpoint } from "../../src/core/Checkpoint";
import {
  checkpointFitsTransferBudget,
  decodeCheckpoint,
  encodeCheckpoint,
  mapStateFitsTransferBudget,
  MAX_CHECKPOINT_TRANSFER_BYTES,
  projectCheckpointBytes,
  projectMapStateBytes,
} from "../../src/core/CheckpointCodec";

// A structurally valid checkpoint (isGameCheckpoint only inspects version,
// ticks, players/units arrays and map), carrying the non-JSON leaves the codec
// exists for: bigints, a Uint8Array, a Uint16Array, a typed-array view and a
// non-finite number.
function sampleCheckpoint(ticks = 42): GameCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    ticks,
    startTick: null,
    isPaused: false,
    winner: null,
    nextPlayerID: 3,
    nextUnitID: 9,
    nextFleetId: 1,
    nextAllianceID: 2,
    unitsVersion: 7,
    territoryVersion: 11,
    map: {
      terrain: new Uint8Array([0, 1, 2, 255]),
      state: new Uint16Array([0, 1024, 65535]),
      numLandTiles: 2,
      numTilesWithFallout: 0,
      waterVersion: 1,
    },
    miniMap: {
      terrain: new Uint8Array([3, 4]),
      state: new Uint16Array([5]),
      numLandTiles: 1,
      numTilesWithFallout: 0,
      waterVersion: 0,
    },
    players: [],
    units: [],
    attacks: [],
    allianceRequests: [],
    alliances: [],
    stats: {
      p1: {
        gold: 9007199254740993n,
        // Non-finite values are not JSON; the codec tags them.
        betrayals: 2n,
      },
    } as unknown as GameCheckpoint["stats"],
    numMirvsLaunched: 12345678901234567890n,
    executions: [],
    execsCount: 0,
  };
}

describe("CheckpointCodec", () => {
  it("round-trips bigints and typed arrays", () => {
    const original = sampleCheckpoint();
    const decoded = decodeCheckpoint(encodeCheckpoint(original));
    expect(decoded).toBeDefined();

    expect(decoded!.map.terrain).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded!.map.terrain)).toEqual([0, 1, 2, 255]);
    expect(decoded!.map.state).toBeInstanceOf(Uint16Array);
    expect(Array.from(decoded!.map.state)).toEqual([0, 1024, 65535]);
    expect(decoded!.numMirvsLaunched).toBe(12345678901234567890n);
    const stats = decoded!.stats as unknown as Record<string, { gold: bigint }>;
    expect(stats.p1.gold).toBe(9007199254740993n);
  });

  it("preserves non-finite numbers", () => {
    const original = sampleCheckpoint();
    // Sneak the non-JSON number into stats, which the codec walks generically.
    (original.stats as Record<string, unknown>).nan = NaN;
    (original.stats as Record<string, unknown>).inf = Infinity;
    const decoded = decodeCheckpoint(encodeCheckpoint(original));
    const stats = decoded!.stats as Record<string, number>;
    expect(Number.isNaN(stats.nan)).toBe(true);
    expect(stats.inf).toBe(Infinity);
  });

  it("serializes a typed-array view without its surrounding buffer", () => {
    const backing = new Uint8Array([9, 9, 7, 8, 9, 9]);
    const view = backing.subarray(2, 4);
    const original = sampleCheckpoint();
    original.map.terrain = view;
    const decoded = decodeCheckpoint(encodeCheckpoint(original));
    expect(Array.from(decoded!.map.terrain)).toEqual([7, 8]);
  });

  it("returns undefined for corrupt or non-checkpoint input", () => {
    expect(decodeCheckpoint("not json")).toBeUndefined();
    expect(decodeCheckpoint(JSON.stringify({ version: 999 }))).toBeUndefined();
    expect(
      decodeCheckpoint(
        JSON.stringify({
          version: CHECKPOINT_VERSION,
          ticks: 1,
          players: [],
          units: [],
          map: null,
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps the transfer cap inside the game socket's frame limit", () => {
    expect(MAX_CHECKPOINT_TRANSFER_BYTES).toBeLessThan(1024 * 1024);
  });

  describe("projectCheckpointBytes", () => {
    it("is a conservative estimate of the encoded size", () => {
      const checkpoint = sampleCheckpoint();
      const projected = projectCheckpointBytes(checkpoint);
      const actual = encodeCheckpoint(checkpoint).length;
      // The projection must never suggest a blob is smaller than it is, and it
      // should not be wildly pessimistic for a small state.
      expect(projected).toBeGreaterThanOrEqual(actual);
      expect(projected).toBeLessThan(actual * 20);
    });

    it("flags a large-map checkpoint as over budget without encoding it", () => {
      const checkpoint = sampleCheckpoint();
      // A World-sized main map plus its 4x minimap: ~2.5M tiles of state, far
      // past the cap before any player/unit data.
      checkpoint.map.terrain = new Uint8Array(2_000_000);
      checkpoint.map.state = new Uint16Array(2_000_000);
      checkpoint.miniMap.terrain = new Uint8Array(500_000);
      checkpoint.miniMap.state = new Uint16Array(500_000);
      expect(projectCheckpointBytes(checkpoint)).toBeGreaterThan(
        MAX_CHECKPOINT_TRANSFER_BYTES,
      );
      expect(checkpointFitsTransferBudget(checkpoint)).toBe(false);
    });

    it("accepts a small checkpoint", () => {
      expect(checkpointFitsTransferBudget(sampleCheckpoint())).toBe(true);
    });

    it("classifies map sizes for the worker capture guard", () => {
      // A small test-sized map fits; a World-sized one cannot and must not be
      // captured at all.
      expect(mapStateFitsTransferBudget(200, 200)).toBe(true);
      expect(mapStateFitsTransferBudget(2000, 1000)).toBe(false);
      expect(projectMapStateBytes(2000, 1000)).toBeGreaterThan(
        MAX_CHECKPOINT_TRANSFER_BYTES,
      );
    });
  });
});
