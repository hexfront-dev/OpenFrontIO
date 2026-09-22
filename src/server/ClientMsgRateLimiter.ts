import { RateLimiter } from "limiter";
import { MAX_CHECKPOINT_TRANSFER_BYTES } from "../core/CheckpointCodec";
import { ClientID } from "../core/Schemas";

const INTENTS_PER_SECOND = 10;
const INTENTS_PER_MINUTE = 150;
const MAX_INTENT_SIZE = 2000;
// A rejoin makes the server serialize and send the turn history since
// `lastTurn`, which is the full game so far when lastTurn is 0. A real client
// only sends one per (re)connect, so anything beyond a handful per minute is
// abuse.
const REJOINS_PER_MINUTE = 5;
// A host uploads a checkpoint when the player presses the in-game save button,
// so a handful per minute is already generous; the payload is large, so the rate
// limit is really there to bound decode/disk churn.
const CHECKPOINTS_PER_MINUTE = 4;
const TOTAL_BYTES = 5 * 1024 * 1024; // 5MB per client
export type RateLimitResult = "ok" | "limit" | "kick";

interface ClientBucket {
  perSecond: RateLimiter;
  perMinute: RateLimiter;
  rejoinPerMinute: RateLimiter;
  checkpointPerMinute: RateLimiter;
  totalBytes: number;
}

export class ClientMsgRateLimiter {
  private buckets = new Map<ClientID, ClientBucket>();

  check(clientID: ClientID, type: string, bytes: number): RateLimitResult {
    const bucket = this.getOrCreate(clientID);
    // Checkpoint payloads are large, infrequent, host-only uploads; counting
    // them toward the per-client byte budget would kick a host out of a long
    // game after a few captures. They are bounded by size + rate below instead.
    // Phase 7 chunked uploads are the same payload spread over several frames,
    // so they are exempt too; the game enforces the chunk/byte/rate budget.
    if (type !== "checkpoint" && type !== "checkpoint_chunk") {
      bucket.totalBytes += bytes;
    }

    if (bucket.totalBytes >= TOTAL_BYTES) return "kick";

    if (type === "checkpoint") {
      // The client caps the *string*; the frame carries a little zbin overhead
      // on top, so allow headroom before treating it as hostile.
      if (bytes > MAX_CHECKPOINT_TRANSFER_BYTES + 64 * 1024) return "kick";
      if (!bucket.checkpointPerMinute.tryRemoveTokens(1)) return "limit";
    } else if (type === "intent") {
      // Intents are stored in turn history for the duration of the game, so
      // oversized intents would accumulate and fill up server RAM.
      // Intents are also sent to all players, so it increase outgoing
      // data.
      // Intents should never be larger than MAX_INTENT_SIZE, so we assume the client is malicious.
      if (bytes > MAX_INTENT_SIZE) {
        return "kick";
      }
      if (
        !bucket.perSecond.tryRemoveTokens(1) ||
        !bucket.perMinute.tryRemoveTokens(1)
      ) {
        return "limit";
      }
    } else if (type === "rejoin") {
      if (!bucket.rejoinPerMinute.tryRemoveTokens(1)) {
        return "limit";
      }
    }

    return "ok";
  }

  private getOrCreate(clientID: ClientID): ClientBucket {
    const existing = this.buckets.get(clientID);
    if (existing) {
      return existing;
    }
    const bucket = {
      perSecond: new RateLimiter({
        tokensPerInterval: INTENTS_PER_SECOND,
        interval: "second",
      }),
      perMinute: new RateLimiter({
        tokensPerInterval: INTENTS_PER_MINUTE,
        interval: "minute",
      }),
      rejoinPerMinute: new RateLimiter({
        tokensPerInterval: REJOINS_PER_MINUTE,
        interval: "minute",
      }),
      checkpointPerMinute: new RateLimiter({
        tokensPerInterval: CHECKPOINTS_PER_MINUTE,
        interval: "minute",
      }),
      totalBytes: 0,
    };
    this.buckets.set(clientID, bucket);
    return bucket;
  }
}
