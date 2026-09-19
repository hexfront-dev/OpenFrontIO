import {
  GameCheckpoint,
  isGameCheckpoint,
  MapStateCheckpoint,
} from "./Checkpoint";

/**
 * B2: a portable, schema-free serialization for `GameCheckpoint` blobs that have
 * to leave the process (the host client uploads one to the game server, and the
 * server hands it back on resume).
 *
 * Checkpoints are not JSON: player/economy values are `bigint`, and the map
 * state is `Uint8Array`/`Uint16Array`. `JSON.stringify` silently mangles the
 * former (throws) and explodes the latter into per-index keys. This codec keeps
 * JSON as the container (so the blob stays inspectable and `gitCommit`-pinned)
 * and tags the non-JSON leaves:
 *
 *   bigint       -> { "$bigint": "123" }
 *   Uint8Array   -> { "$u8": "<base64>" }
 *   Uint16Array  -> { "$u16": "<base64>" }
 *   NaN/±Infinity -> { "$num": "NaN" | "Infinity" | "-Infinity" }
 *
 * `undefined` object properties are dropped by JSON, which matches how an absent
 * optional checkpoint field already reads back.
 *
 * Transferred as a string (not a parsed object) because the wire encoder is
 * positional and cannot carry arbitrary structured values; the string is then
 * `z.string()` on both the start and the client checkpoint messages.
 */

// The game WebSocket caps a frame at MAX_WEBSOCKET_PAYLOAD_BYTES (1 MiB), so a
// host upload above this is skipped and the save falls back to full-history
// resume. Kept well under the frame cap to leave room for the zbin envelope.
export const MAX_CHECKPOINT_TRANSFER_BYTES = 900_000;

const BIGINT_TAG = "$bigint";
const U8_TAG = "$u8";
const U16_TAG = "$u16";
const NUM_TAG = "$num";

// Chunked so `String.fromCharCode(...)` cannot blow the argument stack on a
// multi-megabyte map buffer.
const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return { [BIGINT_TAG]: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { [U8_TAG]: bytesToBase64(value) };
  }
  if (value instanceof Uint16Array) {
    return {
      [U16_TAG]: bytesToBase64(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      ),
    };
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { [NUM_TAG]: String(value) };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const tagged = value as Record<string, unknown>;
  const bigint = tagged[BIGINT_TAG];
  if (typeof bigint === "string") {
    return BigInt(bigint);
  }
  const u8 = tagged[U8_TAG];
  if (typeof u8 === "string") {
    return base64ToBytes(u8);
  }
  const u16 = tagged[U16_TAG];
  if (typeof u16 === "string") {
    const bytes = base64ToBytes(u16);
    return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
  }
  const num = tagged[NUM_TAG];
  if (typeof num === "string") {
    return Number(num);
  }
  return value;
}

// Per-entity size estimates (tagged-JSON characters) for the parts of a
// checkpoint that are not the map. Deliberately generous: an over-estimate only
// makes the client skip an upload and fall back to full replay, never desync.
const STATS_PER_PLAYER_BYTES = 800;
const PLAYER_BASE_BYTES = 300;
const PLAYER_REF_BYTES = 8;
const PLAYER_ID_BYTES = 44;
const PLAYER_TARGET_BYTES = 40;
const PLAYER_EMOJI_BYTES = 90;
const PLAYER_DONATION_BYTES = 40;
const ALLIANCE_REQUEST_BYTES = 100;
const ALLIANCE_BYTES = 160;
const UNIT_BASE_BYTES = 350;
const UNIT_TICK_BYTES = 5;
const UNIT_TOLL_BYTES = 60;
const ATTACK_BASE_BYTES = 150;
const EXECUTION_BYTES = 200;
const CHECKPOINT_ENVELOPE_BYTES = 2_000;

function base64Length(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

function typedArrayBase64Length(
  value: Uint8Array | Uint16Array | undefined,
): number {
  if (value === undefined) return 0;
  const bytesPerElement = value instanceof Uint16Array ? 2 : 1;
  return base64Length(value.length * bytesPerElement);
}

/**
 * A cheap estimate of the tagged-JSON length `encodeCheckpoint` would produce,
 * computed without building the multi-megabyte string. The dominant, unbounded
 * cost is the two map typed arrays (main + minimap, fixed per map size), which
 * is measured exactly; the bounded per-entity arrays are estimated with
 * conservative constants.
 *
 * Callers use this to decide whether a checkpoint can fit the transfer cap
 * before allocating the encoded string (see docs/SaveResumeLongGames.md).
 * Over-estimating is safe: it only costs a fallback to full-history replay.
 */
export function projectCheckpointBytes(checkpoint: GameCheckpoint): number {
  const mapBytes = (m: MapStateCheckpoint): number =>
    typedArrayBase64Length(m.terrain) + typedArrayBase64Length(m.state);

  let bytes = CHECKPOINT_ENVELOPE_BYTES;
  bytes += mapBytes(checkpoint.map) + mapBytes(checkpoint.miniMap);
  bytes += Object.keys(checkpoint.stats).length * STATS_PER_PLAYER_BYTES;

  for (const p of checkpoint.players) {
    bytes += PLAYER_BASE_BYTES;
    bytes += p.tiles.length * PLAYER_REF_BYTES;
    bytes += p.avoidedTiles.length * PLAYER_REF_BYTES;
    bytes += p.unitIds.length * PLAYER_REF_BYTES;
    bytes += p.outgoingAttackIds.length * PLAYER_ID_BYTES;
    bytes += p.incomingAttackIds.length * PLAYER_ID_BYTES;
    bytes += p.relations.length * 12;
    bytes += p.tollRates.length * 16;
    bytes += p.embargoes.length * 50;
    bytes += p.targets.length * PLAYER_TARGET_BYTES;
    bytes += p.outgoingEmojis.length * PLAYER_EMOJI_BYTES;
    bytes += p.outgoingQuickChats.length * 20;
    bytes += p.sentDonations.length * PLAYER_DONATION_BYTES;
    bytes +=
      (p.pastOutgoingAllianceRequests?.length ?? 0) * ALLIANCE_REQUEST_BYTES;
    bytes += (p.expiredAlliances?.length ?? 0) * ALLIANCE_BYTES;
  }

  for (const u of checkpoint.units) {
    bytes += UNIT_BASE_BYTES;
    bytes += u.missileTimerQueue.length * UNIT_TICK_BYTES;
    bytes += u.tollTicks.length * UNIT_TICK_BYTES;
    bytes += u.tolls.length * UNIT_TOLL_BYTES;
  }

  for (const a of checkpoint.attacks) {
    bytes += ATTACK_BASE_BYTES + a.border.length * PLAYER_REF_BYTES;
  }

  bytes += checkpoint.allianceRequests.length * ALLIANCE_REQUEST_BYTES;
  bytes += checkpoint.alliances.length * ALLIANCE_BYTES;
  bytes += checkpoint.executions.length * EXECUTION_BYTES;
  return bytes;
}

/**
 * True when a checkpoint is projected to fit under the transfer cap, so the
 * caller can encode and upload it. Checkpoints that fail this are skipped and
 * the resume falls back to full-history replay.
 */
export function checkpointFitsTransferBudget(
  checkpoint: GameCheckpoint,
): boolean {
  return projectCheckpointBytes(checkpoint) <= MAX_CHECKPOINT_TRANSFER_BYTES;
}

/**
 * Projected encoded size of a map's raw typed arrays: the main map plus its 4x
 * minimap, each terrain (Uint8) and state (Uint16), base64-encoded. This is the
 * fixed floor of a checkpoint, known before any capture, so the worker can skip
 * allocating a checkpoint on maps that can never fit one.
 */
export function projectMapStateBytes(width: number, height: number): number {
  const miniWidth = Math.ceil(width / 4);
  const miniHeight = Math.ceil(height / 4);
  const tiles = width * height;
  const miniTiles = miniWidth * miniHeight;
  return base64Length((tiles + miniTiles) * 3);
}

/**
 * True when a map's fixed state alone fits the transfer cap. Large maps return
 * false and deliberately rely on (chunked) full-history replay instead of
 * capturing a checkpoint that could never be sent.
 */
export function mapStateFitsTransferBudget(
  width: number,
  height: number,
): boolean {
  return projectMapStateBytes(width, height) <= MAX_CHECKPOINT_TRANSFER_BYTES;
}

/** Serialize a checkpoint to its tagged-JSON wire/store form. */
export function encodeCheckpoint(checkpoint: GameCheckpoint): string {
  return JSON.stringify(checkpoint, replacer);
}

/**
 * Parse a checkpoint blob, or undefined when it is not a checkpoint of the
 * current version (corrupt, legacy, or hostile input). Callers treat undefined
 * as "no checkpoint" and fall back to replaying the full history.
 */
export function decodeCheckpoint(
  serialized: string,
): GameCheckpoint | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized, reviver);
  } catch {
    return undefined;
  }
  return isGameCheckpoint(parsed) ? parsed : undefined;
}
