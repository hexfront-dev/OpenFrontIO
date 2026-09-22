import { GameCheckpoint } from "../Checkpoint";
import {
  BuildableUnit,
  PlayerActions,
  PlayerBorderTiles,
  PlayerBuildableUnitType,
  PlayerID,
  PlayerProfile,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { ErrorUpdate, GameUpdateViewData } from "../game/GameUpdates";
import { ClientID, GameStartInfo, Turn } from "../Schemas";

export type WorkerMessageType =
  | "init"
  | "initialized"
  | "turn"
  | "turns"
  | "checkpoint"
  | "request_checkpoint"
  | "game_update"
  | "game_update_batch"
  | "game_error"
  | "player_actions"
  | "player_actions_result"
  | "player_buildables"
  | "player_buildables_result"
  | "player_profile"
  | "player_profile_result"
  | "player_border_tiles"
  | "player_border_tiles_result"
  | "attack_clustered_positions"
  | "attack_clustered_positions_result"
  | "transport_ship_spawn"
  | "transport_ship_spawn_result";

// Base interface for all messages
interface BaseWorkerMessage {
  type: WorkerMessageType;
  id?: string;
}

// Messages from main thread to worker
export interface InitMessage extends BaseWorkerMessage {
  type: "init";
  gameStartInfo: GameStartInfo;
  clientID: ClientID | undefined;
  cdnBase: string;
  /** B2: restore this checkpoint before executing any turns (resume path). */
  checkpoint?: GameCheckpoint;
}

export interface TurnMessage extends BaseWorkerMessage {
  type: "turn";
  turn: Turn;
}

// A whole backlog of turns in one message. A resumed save can hand over many
// thousands of dense turns; a postMessage per turn costs a structured clone
// each, so the resume path sends them batched instead.
export interface TurnsMessage extends BaseWorkerMessage {
  type: "turns";
  turns: Turn[];
}

/**
 * B2: a manual request to capture a checkpoint now. Checkpoints are no longer
 * captured on a timer; the in-game save button drives this so the player decides
 * when to pay the capture/encode cost.
 */
export interface RequestCheckpointMessage extends BaseWorkerMessage {
  type: "request_checkpoint";
}

// Messages from worker to main thread
export interface InitializedMessage extends BaseWorkerMessage {
  type: "initialized";
}

export interface GameUpdateMessage extends BaseWorkerMessage {
  type: "game_update";
  gameUpdate: GameUpdateViewData;
}

export interface GameUpdateBatchMessage extends BaseWorkerMessage {
  type: "game_update_batch";
  gameUpdates: GameUpdateViewData[];
}

/**
 * B2: an on-demand core checkpoint the main thread caches for autosaves. The
 * worker encodes it (core/CheckpointCodec.ts) so the multi-megabyte structured
 * clone and gzip never run on the UI thread; the main thread only handles the
 * resulting wire string. `ticks` is carried alongside so the autosave can bound
 * the checkpoint to its recorded turns without decoding.
 */
export interface CheckpointMessage extends BaseWorkerMessage {
  type: "checkpoint";
  checkpointWire: string;
  ticks: number;
}

export interface GameErrorMessage extends BaseWorkerMessage {
  type: "game_error";
  error: ErrorUpdate;
}

export interface PlayerActionsMessage extends BaseWorkerMessage {
  type: "player_actions";
  playerID: PlayerID;
  x?: number;
  y?: number;
  units?: readonly PlayerBuildableUnitType[] | null;
}

export interface PlayerActionsResultMessage extends BaseWorkerMessage {
  type: "player_actions_result";
  result: PlayerActions;
}

export interface PlayerBuildablesMessage extends BaseWorkerMessage {
  type: "player_buildables";
  playerID: PlayerID;
  x?: number;
  y?: number;
  units?: readonly PlayerBuildableUnitType[];
}

export interface PlayerBuildablesResultMessage extends BaseWorkerMessage {
  type: "player_buildables_result";
  result: BuildableUnit[];
}

export interface PlayerProfileMessage extends BaseWorkerMessage {
  type: "player_profile";
  playerID: number;
}

export interface PlayerProfileResultMessage extends BaseWorkerMessage {
  type: "player_profile_result";
  result: PlayerProfile;
}

export interface PlayerBorderTilesMessage extends BaseWorkerMessage {
  type: "player_border_tiles";
  playerID: PlayerID;
}

export interface PlayerBorderTilesResultMessage extends BaseWorkerMessage {
  type: "player_border_tiles_result";
  result: PlayerBorderTiles;
}

export interface AttackClusteredPositionsMessage extends BaseWorkerMessage {
  type: "attack_clustered_positions";
  playerID: number;
  attackID?: string;
}

export interface AttackClusteredPositionsResultMessage extends BaseWorkerMessage {
  type: "attack_clustered_positions_result";
  attacks: { id: string; positions: { x: number; y: number }[] }[];
}

export interface TransportShipSpawnMessage extends BaseWorkerMessage {
  type: "transport_ship_spawn";
  playerID: PlayerID;
  targetTile: TileRef;
}

export interface TransportShipSpawnResultMessage extends BaseWorkerMessage {
  type: "transport_ship_spawn_result";
  result: TileRef | false;
}

// Union types for type safety
export type MainThreadMessage =
  | InitMessage
  | TurnMessage
  | TurnsMessage
  | RequestCheckpointMessage
  | PlayerActionsMessage
  | PlayerBuildablesMessage
  | PlayerProfileMessage
  | PlayerBorderTilesMessage
  | AttackClusteredPositionsMessage
  | TransportShipSpawnMessage;

// Message send from worker
export type WorkerMessage =
  | InitializedMessage
  | GameUpdateMessage
  | GameUpdateBatchMessage
  | CheckpointMessage
  | GameErrorMessage
  | PlayerActionsResultMessage
  | PlayerBuildablesResultMessage
  | PlayerProfileResultMessage
  | PlayerBorderTilesResultMessage
  | AttackClusteredPositionsResultMessage
  | TransportShipSpawnResultMessage;
