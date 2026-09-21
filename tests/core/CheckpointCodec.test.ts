import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_VERSION, GameCheckpoint } from "../../src/core/Checkpoint";
import {
  checkpointFitsTransferBudget,
  decodeCheckpoint,
  decodeCheckpointWire,
  encodeCheckpoint,
  encodeCheckpointGzip,
  isCompressedCheckpoint,
  mapStateFitsCheckpointCapture,
  mapStateFitsTransferBudget,
  MAX_CHECKPOINT_CAPTURE_BYTES,
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

  describe("Phase 7 gzip transport", () => {
    it("round-trips a checkpoint through the gzip wire form", async () => {
      const original = sampleCheckpoint();
      const wire = await encodeCheckpointGzip(original);
      expect(isCompressedCheckpoint(wire)).toBe(true);
      // The plaintext decoder must not accept the compressed form.
      expect(decodeCheckpoint(wire)).toBeUndefined();

      const decoded = await decodeCheckpointWire(wire);
      expect(decoded).toBeDefined();
      expect(Array.from(decoded!.map.terrain)).toEqual([0, 1, 2, 255]);
      expect(decoded!.numMirvsLaunched).toBe(12345678901234567890n);
    });

    it("decodes a plaintext wire checkpoint through the same entry point", async () => {
      const original = sampleCheckpoint();
      const decoded = await decodeCheckpointWire(encodeCheckpoint(original));
      expect(decoded?.ticks).toBe(42);
    });

    it("returns undefined for a corrupt gzip payload", async () => {
      expect(await decodeCheckpointWire("gz:not-base64!!")).toBeUndefined();
      expect(
        await decodeCheckpointWire("gz:" + btoa("not gzip")),
      ).toBeUndefined();
    });
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
      // A small test-sized map fits the single-frame cap; a World-sized one
      // cannot and must compress instead.
      expect(mapStateFitsTransferBudget(200, 200)).toBe(true);
      expect(mapStateFitsTransferBudget(2000, 1000)).toBe(false);
      expect(projectMapStateBytes(2000, 1000)).toBeGreaterThan(
        MAX_CHECKPOINT_TRANSFER_BYTES,
      );
    });
  });

  describe("compressed capture eligibility", () => {
    it("uses the real minimap dimensions in the estimate", () => {
      // World Normal: 2000x1000 main with a 1000x500 map4x minimap is four
      // times the minimap area the default 1/4 estimate assumes.
      const withRealMini = projectMapStateBytes(2000, 1000, 1000, 500);
      const withDefaultMini = projectMapStateBytes(2000, 1000);
      expect(withRealMini).toBeGreaterThan(withDefaultMini);
    });

    it("accepts the largest shipped map but not one above the ceiling", () => {
      // Sol (4432x2528) with its real map4x minimap is the largest map today.
      expect(mapStateFitsCheckpointCapture(4432, 2528, 2216, 1264)).toBe(true);
      expect(projectMapStateBytes(4432, 2528, 2216, 1264)).toBeLessThanOrEqual(
        MAX_CHECKPOINT_CAPTURE_BYTES,
      );
      // A hypothetical map past the ceiling must still be rejected so we fall
      // back to full-history replay rather than attempting an impossible upload.
      expect(mapStateFitsCheckpointCapture(4000, 4000, 2000, 2000)).toBe(false);
    });

    it("qualifies every shipped map at Normal and Compact sizes", () => {
      const mapsDir = path.join(process.cwd(), "resources", "maps");
      const dirs = fs
        .readdirSync(mapsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory());
      expect(dirs.length).toBeGreaterThan(0);

      for (const dir of dirs) {
        const manifestPath = path.join(mapsDir, dir.name, "manifest.json");
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          map: { width: number; height: number };
          map4x: { width: number; height: number };
          map16x: { width: number; height: number };
        };
        // Normal: full-resolution main map + map4x minimap.
        expect(
          mapStateFitsCheckpointCapture(
            manifest.map.width,
            manifest.map.height,
            manifest.map4x.width,
            manifest.map4x.height,
          ),
          `Normal ${dir.name}`,
        ).toBe(true);
        // Compact: map4x main map + map16x minimap.
        expect(
          mapStateFitsCheckpointCapture(
            manifest.map4x.width,
            manifest.map4x.height,
            manifest.map16x.width,
            manifest.map16x.height,
          ),
          `Compact ${dir.name}`,
        ).toBe(true);
      }
    });
  });
});
