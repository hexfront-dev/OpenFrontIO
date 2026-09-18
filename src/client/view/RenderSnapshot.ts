import {
  NameViewData,
  NukeState,
  TransportShipState,
  WarshipState,
} from "../../core/game/Game";
import { PlayerCosmetics } from "../../core/Schemas";
import {
  NameEntry,
  PlayerState,
  PlayerStatic,
  UnitState,
} from "../render/types";

/**
 * A renderer-facing snapshot of a running GameView (B1).
 *
 * This is a *preview*: it carries enough to seed a fresh GameView and paint the
 * saved map immediately, without serializing any core simulation state and
 * without waiting for the worker to replay history. When the worker's replay
 * catches up (or a B2 checkpoint resume takes over), the authoritative state
 * replaces it.
 *
 * PII: names/clanTags/clientIDs here are the same ones already present in
 * GameStartInfo.players, so a snapshot adds no new personal data.
 */
export interface SnapshotPlayer {
  static: PlayerStatic;
  state: PlayerState;
  nameData?: NameViewData;
  cosmetics: PlayerCosmetics;
}

export interface SnapshotUnit {
  state: UnitState;
  warshipState?: WarshipState;
  transportShipState?: TransportShipState;
  nukeState?: NukeState;
  createdAt: number;
}

export interface RenderSnapshot {
  tick: number;
  startTick: number | null;
  width: number;
  height: number;
  tileState: Uint16Array;
  terrain: Uint8Array | null;
  players: SnapshotPlayer[];
  units: SnapshotUnit[];
  names: NameEntry[];
}

// Bump when the serialized shape changes; older payloads fail to decode and the
// resume path simply falls back to replay.
const SNAPSHOT_ENCODING_VERSION = 1;

interface SerializedSnapshot {
  v: number;
  tick: number;
  startTick: number | null;
  w: number;
  h: number;
  tiles: string; // base64 of the Uint16Array bytes
  terrain: string | null; // base64 of the Uint8Array bytes
  players: SnapshotPlayer[];
  units: SnapshotUnit[];
  names: NameEntry[];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // keep fromCharCode's argument list bounded
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Serialize a snapshot to a compact JSON string for storage. */
export function encodeRenderSnapshot(snapshot: RenderSnapshot): string {
  const serialized: SerializedSnapshot = {
    v: SNAPSHOT_ENCODING_VERSION,
    tick: snapshot.tick,
    startTick: snapshot.startTick,
    w: snapshot.width,
    h: snapshot.height,
    tiles: bytesToBase64(
      new Uint8Array(
        snapshot.tileState.buffer,
        snapshot.tileState.byteOffset,
        snapshot.tileState.byteLength,
      ),
    ),
    terrain: snapshot.terrain === null ? null : bytesToBase64(snapshot.terrain),
    players: snapshot.players,
    units: snapshot.units,
    names: snapshot.names,
  };
  return JSON.stringify(serialized);
}

/**
 * Decode a stored snapshot. Returns undefined on any malformed/unknown payload
 * so a caller can fall back to a full replay instead of crashing on resume.
 */
export function decodeRenderSnapshot(
  encoded: string,
): RenderSnapshot | undefined {
  try {
    const parsed = JSON.parse(encoded) as SerializedSnapshot;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.v !== SNAPSHOT_ENCODING_VERSION ||
      typeof parsed.tick !== "number" ||
      typeof parsed.w !== "number" ||
      typeof parsed.h !== "number" ||
      typeof parsed.tiles !== "string" ||
      !Array.isArray(parsed.players) ||
      !Array.isArray(parsed.units) ||
      !Array.isArray(parsed.names)
    ) {
      return undefined;
    }
    const tiles = base64ToBytes(parsed.tiles);
    const tileState = new Uint16Array(
      tiles.buffer,
      tiles.byteOffset,
      Math.floor(tiles.byteLength / 2),
    );
    if (tileState.length !== parsed.w * parsed.h) {
      return undefined;
    }
    const terrain =
      parsed.terrain === null ? null : base64ToBytes(parsed.terrain);
    if (terrain !== null && terrain.length !== parsed.w * parsed.h) {
      return undefined;
    }
    return {
      tick: parsed.tick,
      startTick: parsed.startTick ?? null,
      width: parsed.w,
      height: parsed.h,
      tileState,
      terrain,
      players: parsed.players,
      units: parsed.units,
      names: parsed.names,
    };
  } catch {
    return undefined;
  }
}
