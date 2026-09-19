import { assetUrl } from "../AssetUrls";
import { CHECKPOINT_EVERY_TURNS } from "../Checkpoint";
import { FetchGameMapLoader } from "../game/FetchGameMapLoader";
import { ErrorUpdate, GameUpdateViewData } from "../game/GameUpdates";
import { createGameRunner, GameRunner } from "../GameRunner";
import {
  AttackClusteredPositionsResultMessage,
  CheckpointMessage,
  InitializedMessage,
  MainThreadMessage,
  PlayerActionsResultMessage,
  PlayerBorderTilesResultMessage,
  PlayerBuildablesResultMessage,
  PlayerProfileResultMessage,
  TransportShipSpawnResultMessage,
  WorkerMessage,
} from "./WorkerMessages";

const ctx: Worker = self as any;
globalThis.__ASSET_MANIFEST__ = __ASSET_MANIFEST__;
let gameRunner: Promise<GameRunner> | null = null;
// B2: last tick a checkpoint was emitted, so a no-op drain doesn't resend one.
let lastCheckpointTick = -1;
const mapLoader = new FetchGameMapLoader((path) => assetUrl(`maps/${path}`));
// Yield threshold; not a backlog cap. Used to avoid monopolizing the worker task
// and flooding the main thread with messages during catch-up. A resumed save can
// hand over thousands of turns at once, so a larger batch keeps the hop count
// (and therefore per-message overhead) low while still yielding often enough
// for player_* requests to interleave.
const MAX_TICKS_BEFORE_YIELD = 32;

let drainScheduled = false;
let draining = false;
let drainRequested = false;

// Schedule a drain on a macrotask WITHOUT setTimeout's nesting clamp. Repeated
// setTimeout(0) hops are clamped to ~4ms each once nested, so a long catch-up
// (one hop per few ticks) would add tens of seconds of pure idle waiting.
// A MessageChannel task yields to the event loop at full speed.
const drainChannel = new MessageChannel();
drainChannel.port1.onmessage = () => {
  void drain().catch((e) => {
    console.error("Worker drain failed:", e);
  });
};

function scheduleDrain(): void {
  drainRequested = true;
  if (drainScheduled || draining) {
    return;
  }
  drainScheduled = true;
  drainChannel.port2.postMessage(null);
}

async function drain(): Promise<void> {
  drainScheduled = false;
  if (draining) {
    return;
  }
  if (!gameRunner) {
    return;
  }

  draining = true;
  drainRequested = false;
  let shouldContinue: boolean;
  try {
    const gr = await gameRunner;
    if (!gr) {
      return;
    }

    const batch: GameUpdateViewData[] = [];
    const onTickUpdate = (gu: GameUpdateViewData | ErrorUpdate) => {
      if (!("updates" in gu)) {
        if ("errMsg" in gu) {
          sendMessage({ type: "game_error", error: gu } as WorkerMessage);
        }
        return;
      }
      batch.push(gu);
    };

    // Temporarily route tick callbacks into this drain's batch.
    tickUpdateSink = onTickUpdate;

    let ticksRun = 0;
    while (ticksRun < MAX_TICKS_BEFORE_YIELD && gr.pendingTurns() > 0) {
      const ok = gr.executeNextTick(gr.pendingTurns());
      if (!ok) {
        break;
      }
      ticksRun++;
    }

    tickUpdateSink = null;

    sendGameUpdateBatch(batch);

    // B2: emit a checkpoint at the configured cadence so the main thread can
    // attach it to the next autosave. A checkpoint at tick T covers turns
    // [0, T); the suffix is replayed on resume.
    maybeSendCheckpoint(gr);

    shouldContinue = gr.pendingTurns() > 0;
  } finally {
    tickUpdateSink = null;
    draining = false;
  }

  if (shouldContinue || drainRequested) {
    scheduleDrain();
  }
}

let tickUpdateSink: ((gu: GameUpdateViewData | ErrorUpdate) => void) | null =
  null;

function gameUpdate(gu: GameUpdateViewData | ErrorUpdate) {
  tickUpdateSink?.(gu);
}

function sendGameUpdateBatch(gameUpdates: GameUpdateViewData[]): void {
  if (gameUpdates.length === 0) {
    return;
  }

  const transfers: Transferable[] = [];
  for (const gu of gameUpdates) {
    transfers.push(gu.packedTileUpdates.buffer);
    if (gu.packedMotionPlans) {
      transfers.push(gu.packedMotionPlans.buffer);
    }
    if (gu.packedPlayerUpdates) {
      transfers.push(gu.packedPlayerUpdates.buffer);
    }
    if (gu.packedAttackUpdates) {
      transfers.push(gu.packedAttackUpdates.buffer);
    }
    if (gu.packedNukeImpacts) {
      transfers.push(gu.packedNukeImpacts.buffer);
    }
  }

  ctx.postMessage(
    {
      type: "game_update_batch",
      gameUpdates,
    } as WorkerMessage,
    transfers,
  );
}

function sendMessage(message: WorkerMessage) {
  ctx.postMessage(message);
}

function maybeSendCheckpoint(gr: GameRunner): void {
  const ticks = gr.game.ticks();
  if (ticks <= 0 || ticks % CHECKPOINT_EVERY_TURNS !== 0) {
    return;
  }
  if (ticks === lastCheckpointTick) {
    return;
  }
  // Mark this tick attempted even on failure: the game state cannot change
  // between drains at the same tick, so a retry would compute the same answer.
  lastCheckpointTick = ticks;
  const checkpoint = gr.checkpoint();
  if (checkpoint === undefined) {
    return;
  }
  sendMessage({ type: "checkpoint", checkpoint } as CheckpointMessage);
}

ctx.addEventListener("message", async (e: MessageEvent<MainThreadMessage>) => {
  const message = e.data;

  switch (message.type) {
    case "init":
      try {
        // Set before createGameRunner so map fetches via mapLoader pick up the
        // CDN base. Workers have no `window`, so AssetUrls falls back to this.
        globalThis.__CDN_BASE__ = message.cdnBase;
        gameRunner = createGameRunner(
          message.gameStartInfo,
          message.clientID,
          mapLoader,
          gameUpdate,
        ).then((gr) => {
          // B2: restore before announcing readiness so no turn is executed
          // against the fresh state.
          if (message.checkpoint !== undefined) {
            gr.restoreFromCheckpoint(message.checkpoint);
          }
          sendMessage({
            type: "initialized",
            id: message.id,
          } as InitializedMessage);
          return gr;
        });
      } catch (error) {
        console.error("Failed to initialize game runner:", error);
        throw error;
      }
      break;

    case "turn":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const gr = await gameRunner;
        gr.addTurn(message.turn);
        scheduleDrain();
      } catch (error) {
        console.error("Failed to process turn:", error);
        throw error;
      }
      break;

    case "turns":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const gr = await gameRunner;
        gr.addTurns(message.turns);
        scheduleDrain();
      } catch (error) {
        console.error("Failed to process turns:", error);
        throw error;
      }
      break;

    case "player_actions":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const actions = (await gameRunner).playerActions(
          message.playerID,
          message.x,
          message.y,
          message.units,
        );
        sendMessage({
          type: "player_actions_result",
          id: message.id,
          result: actions,
        } as PlayerActionsResultMessage);
      } catch (error) {
        console.error("Failed to get actions:", error);
        throw error;
      }
      break;
    case "player_buildables":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const buildables = (await gameRunner).playerBuildables(
          message.playerID,
          message.x,
          message.y,
          message.units,
        );
        sendMessage({
          type: "player_buildables_result",
          id: message.id,
          result: buildables,
        } as PlayerBuildablesResultMessage);
      } catch (error) {
        console.error("Failed to get buildables:", error);
        throw error;
      }
      break;
    case "player_profile":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const profile = (await gameRunner).playerProfile(message.playerID);
        sendMessage({
          type: "player_profile_result",
          id: message.id,
          result: profile,
        } as PlayerProfileResultMessage);
      } catch (error) {
        console.error("Failed to get profile:", error);
        throw error;
      }
      break;
    case "player_border_tiles":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const borderTiles = (await gameRunner).playerBorderTiles(
          message.playerID,
        );
        sendMessage({
          type: "player_border_tiles_result",
          id: message.id,
          result: borderTiles,
        } as PlayerBorderTilesResultMessage);
      } catch (error) {
        console.error("Failed to get border tiles:", error);
        throw error;
      }
      break;
    case "attack_clustered_positions":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const attacks = (await gameRunner).attackClusteredPositions(
          message.playerID,
          message.attackID,
        );
        sendMessage({
          type: "attack_clustered_positions_result",
          id: message.id,
          attacks,
        } as AttackClusteredPositionsResultMessage);
      } catch (error) {
        console.error("Failed to get attack front line centers:", error);
        sendMessage({
          type: "attack_clustered_positions_result",
          id: message.id,
          attacks: [],
        } as AttackClusteredPositionsResultMessage);
      }
      break;
    case "transport_ship_spawn":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const spawnTile = (await gameRunner).bestTransportShipSpawn(
          message.playerID,
          message.targetTile,
        );
        sendMessage({
          type: "transport_ship_spawn_result",
          id: message.id,
          result: spawnTile,
        } as TransportShipSpawnResultMessage);
      } catch (error) {
        console.error("Failed to spawn transport ship:", error);
      }
      break;
    default:
      console.warn("Unknown message :", message);
  }
});

// Error handling
ctx.addEventListener("error", (error) => {
  console.error("Worker error:", error);
});

ctx.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection in worker:", event);
});
