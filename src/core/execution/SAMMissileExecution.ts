import { ExecutionCheckpoint } from "../Checkpoint";
import {
  Execution,
  Game,
  MessageType,
  Player,
  PlayerID,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import {
  PathFinderStepper,
  PathFinderStepperSnapshot,
} from "../pathfinding/PathFinderStepper";
import { PathStatus } from "../pathfinding/types";
import { NukeType } from "../StatsSchemas";

export interface SAMMissileExecutionCheckpoint {
  spawn: TileRef;
  ownerId: PlayerID;
  ownerUnitId: number;
  targetId: number;
  targetTile: TileRef;
  active: boolean;
  missileId: number | null;
  speed: number;
  pathFinder: PathFinderStepperSnapshot<TileRef>;
}

export class SAMMissileExecution implements Execution {
  private active = true;
  private pathFinder: PathFinderStepper<TileRef>;
  private SAMMissile: Unit | undefined;
  private mg: Game;
  private speed: number = 0;

  constructor(
    private spawn: TileRef,
    private _owner: Player,
    private ownerUnit: Unit,
    private target: Unit,
    private targetTile: TileRef,
  ) {}

  /** B2: capture the interceptor's route and target tracking. */
  checkpoint(): ExecutionCheckpoint {
    return {
      kind: "sam_missile",
      data: {
        spawn: this.spawn,
        ownerId: this._owner.id(),
        ownerUnitId: this.ownerUnit.id(),
        targetId: this.target.id(),
        targetTile: this.targetTile,
        active: this.active,
        missileId: this.SAMMissile?.id() ?? null,
        speed: this.speed,
        pathFinder: this.pathFinder.snapshot(),
      } satisfies SAMMissileExecutionCheckpoint,
    };
  }

  /** B2: overwrite this execution from a checkpoint. Returns false if a referenced unit is gone. */
  restoreCheckpoint(game: Game, data: SAMMissileExecutionCheckpoint): boolean {
    const ownerUnit = game.unit(data.ownerUnitId);
    const target = game.unit(data.targetId);
    if (ownerUnit === undefined || target === undefined) return false;
    const missile =
      data.missileId === null ? undefined : game.unit(data.missileId);
    if (data.missileId !== null && missile === undefined) return false;

    this.mg = game;
    this.active = data.active;
    this.spawn = data.spawn;
    this._owner = game.player(data.ownerId);
    this.ownerUnit = ownerUnit;
    this.target = target;
    this.targetTile = data.targetTile;
    this.SAMMissile = missile;
    this.speed = data.speed;
    this.pathFinder = PathFinding.Air(game);
    this.pathFinder.restore(data.pathFinder);
    return true;
  }

  init(mg: Game, ticks: number): void {
    this.pathFinder = PathFinding.Air(mg);
    this.mg = mg;
    this.speed = this.mg.config().defaultSamMissileSpeed();
    this.tick(ticks);
  }

  tick(ticks: number): void {
    this.SAMMissile ??= this._owner.buildUnit(UnitType.SAMMissile, this.spawn, {
      targetUnit: this.target,
    });
    if (!this.SAMMissile.isActive()) {
      this.active = false;
      return;
    }
    // The MIRV carrier itself can't be intercepted, only its warheads
    const nukesWhitelist = [
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRVWarhead,
    ];
    if (
      !this.target.isActive() ||
      !this.ownerUnit.isActive() ||
      this.target.owner() === this.SAMMissile.owner() ||
      !nukesWhitelist.includes(this.target.type())
    ) {
      // Clear the flag so other SAMs can re-target this nuke
      if (this.target.isActive()) {
        this.target.setTargetedBySAM(false);
      }
      this.SAMMissile.delete(false);
      this.active = false;
      return;
    }
    for (let i = 0; i < this.speed; i++) {
      const result = this.pathFinder.next(
        this.SAMMissile.tile(),
        this.targetTile,
      );
      if (result.status === PathStatus.COMPLETE) {
        this.mg.displayMessage(
          "events_display.missile_intercepted",
          MessageType.SAM_HIT,
          this._owner.id(),
          undefined,
          { unit: this.target.type() },
        );
        this.active = false;
        this.target.delete(true, this._owner);
        this.SAMMissile.delete(false);

        // Record stats
        this.mg
          .stats()
          .bombIntercept(this._owner, this.target.type() as NukeType, 1);
        return;
      } else if (result.status === PathStatus.NEXT) {
        this.SAMMissile.move(result.node);
      }
    }
  }

  isActive(): boolean {
    return this.active;
  }
  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
