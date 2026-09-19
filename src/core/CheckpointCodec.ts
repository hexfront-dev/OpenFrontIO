import { GameCheckpoint, isGameCheckpoint } from "./Checkpoint";

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
