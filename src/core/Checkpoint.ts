import {
  EmojiMessage,
  NukeState,
  PlayerID,
  SamLauncherState,
  Team,
  TrainType,
  TransportShipState,
  UnitType,
  WarshipState,
} from "./game/Game";
import { TileRef } from "./game/GameMap";
import { PseudoRandomState } from "./PseudoRandom";
import { AllPlayersStats, ClientID } from "./Schemas";
import { PlayerStats } from "./StatsSchemas";

/**
 * B2 core checkpoints.
 *
 * A checkpoint captures the authoritative deterministic state of a running
 * `GameImpl` so a resume only has to replay the turn suffix that follows it,
 * instead of the whole history. Derived state (unit spatial grid, player
 * border-tile sets, pathfinder caches, water graph) is deliberately not stored:
 * it is rebuilt from the authoritative state on restore.
 *
 * The format is versioned and `gitCommit`-pinned like the rest of the save
 * system: a checkpoint from a different build may not replay identically.
 */
export const CHECKPOINT_VERSION = 1;

/**
 * How often a running game may capture a checkpoint, in turns. Two autosave
 * windows at the current client cadence, chosen so the worst-case suffix replay
 * stays short without capturing (and encoding) the whole map too often.
 */
export const CHECKPOINT_EVERY_TURNS = 200;

export interface MapStateCheckpoint {
  terrain: Uint8Array;
  state: Uint16Array;
  numLandTiles: number;
  numTilesWithFallout: number;
  waterVersion: number;
}

export interface UnitTollCheckpoint {
  tollerSmallID: number;
  percent: number;
  gold: bigint;
  tile: TileRef;
}

export interface UnitCheckpoint {
  id: number;
  type: UnitType;
  ownerId: PlayerID;
  tile: TileRef;
  lastTile: TileRef;
  active: boolean;
  targetTile: TileRef | null;
  targetPlayerId: PlayerID | null;
  targetIsTerraNullius: boolean;
  targetUnitId: number | null;
  health: bigint;
  troops: number;
  lastSetSafeFromPirates: number;
  transportShipState: TransportShipState | null;
  warshipState: WarshipState | null;
  nukeState: NukeState | null;
  reachedTarget: boolean;
  underConstruction: boolean;
  lastOwnerId: PlayerID | null;
  missileTimerQueue: number[];
  hasTrainStation: boolean;
  fleetId: number | null;
  level: number;
  targetable: boolean;
  loaded: boolean | null;
  trainType: TrainType | null;
  deletionAt: number | null;
  samLauncherState: SamLauncherState | null;
  defensePostUpgradeFinishTick: number | null;
  tollTicks: number[];
  tolls: UnitTollCheckpoint[];
}

export interface AttackCheckpoint {
  id: string;
  attackerId: PlayerID;
  /** null when the target is TerraNullius. */
  targetId: PlayerID | null;
  troops: number;
  sourceTile: TileRef | null;
  border: TileRef[];
  active: boolean;
  retreating: boolean;
  retreated: boolean;
}

export interface AllianceRequestCheckpoint {
  requestorId: PlayerID;
  recipientId: PlayerID;
  createdAt: number;
}

export interface AllianceCheckpoint {
  id: number;
  requestorId: PlayerID;
  recipientId: PlayerID;
  createdAt: number;
  expiresAt: number;
  extensionRequestedRequestor: boolean;
  extensionRequestedRecipient: boolean;
}

export interface PlayerCheckpoint {
  id: PlayerID;
  smallID: number;
  gold: bigint;
  troops: bigint;
  tradeGold: bigint;
  trainGold: bigint;
  piracyGold: bigint;
  goldEarned: bigint;
  numUnitsConstructed: [UnitType, number][];
  tiles: TileRef[];
  avoidedTiles: TileRef[];
  unitIds: number[];
  allianceIds: number[];
  outgoingAttackIds: string[];
  incomingAttackIds: string[];
  spawnTile: TileRef | null;
  isDisconnected: boolean;
  markedTraitorTick: number;
  markedDoomsdayClockTick: number;
  rottedAtTick: number;
  betrayalCount: number;
  universalTollRate: number;
  lastDeleteUnitTick: number;
  lastEmbargoAllTick: number;
  lastTileChange: number;
  relations: [number, number][];
  tollRates: [PlayerID, number][];
  embargoes: {
    targetId: PlayerID;
    createdAt: number;
    isTemporary: boolean;
  }[];
  targets: { tick: number; targetId: PlayerID }[];
  outgoingEmojis: EmojiMessage[];
  outgoingQuickChats: [number, number][];
  sentDonations: { recipientId: PlayerID; tick: number }[];
  pseudoRandom: PseudoRandomState;
}

export interface ExecutionCheckpoint {
  kind: string;
  data: unknown;
}

/**
 * B2: process-global counters that ship pathfinders draw from. They are not
 * per-game fields, but they are part of the deterministic state: restoring them
 * keeps a resumed run's rebuild stagger in lockstep with the run it continues.
 */
export interface PathfinderStaticsCheckpoint {
  tradeShipStagger: number;
  transportShipStagger: number;
}

export type CheckpointWinner =
  | { kind: "player"; id: PlayerID }
  | { kind: "team"; team: Team }
  | null;

export interface GameCheckpoint {
  version: number;
  ticks: number;
  startTick: number | null;
  isPaused: boolean;
  winner: CheckpointWinner;
  nextPlayerID: number;
  nextUnitID: number;
  nextFleetId: number;
  nextAllianceID: number;
  unitsVersion: number;
  territoryVersion: number;
  map: MapStateCheckpoint;
  miniMap: MapStateCheckpoint;
  players: PlayerCheckpoint[];
  units: UnitCheckpoint[];
  attacks: AttackCheckpoint[];
  allianceRequests: AllianceRequestCheckpoint[];
  alliances: AllianceCheckpoint[];
  stats: AllPlayersStats;
  numMirvsLaunched: bigint;
  /** Executions that had already run, in tick order. */
  executions: ExecutionCheckpoint[];
  /** Number of leading `executions` entries that were active (not pending). */
  execsCount: number;
  /** Optional for checkpoints written before pathfinder statics were captured. */
  pathfinderStatics?: PathfinderStaticsCheckpoint;
}

/** Serialized form of a `PlayerStats` record (bigints survive structured clone). */
export type CheckpointPlayerStats = PlayerStats;

export type CheckpointClientID = ClientID;

/**
 * True when a value looks like a B2 checkpoint. Cheap structural guard used at
 * the persistence boundary before a full parse.
 */
export function isGameCheckpoint(value: unknown): value is GameCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const cp = value as Partial<GameCheckpoint>;
  return (
    cp.version === CHECKPOINT_VERSION &&
    typeof cp.ticks === "number" &&
    Array.isArray(cp.players) &&
    Array.isArray(cp.units) &&
    typeof cp.map === "object" &&
    cp.map !== null
  );
}
