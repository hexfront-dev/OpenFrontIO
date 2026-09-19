import { ExecutionCheckpoint } from "../Checkpoint";
import {
  Execution,
  Game,
  OwnerComp,
  Unit,
  UnitParams,
  UnitType,
  isUnit,
} from "../game/Game";
import {
  WaterPathFinder,
  WaterPathFinderSnapshot,
} from "../pathfinding/PathFinder";
import { PathStatus } from "../pathfinding/types";
import { PseudoRandom, PseudoRandomState } from "../PseudoRandom";
import { shipMoveInterval } from "./FleetFormation";

export interface MissileShipExecutionCheckpoint {
  warshipId: number | null;
  active: boolean;
  random: PseudoRandomState;
  pathfinder: WaterPathFinderSnapshot;
}

export class MissileShipExecution implements Execution {
  private active = true;
  private warship: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private random: PseudoRandom;

  constructor(
    private input: (UnitParams<UnitType.MissileShip> & OwnerComp) | Unit,
  ) {}

  /** B2: capture the missile ship's patrol state and cached route. */
  checkpoint(): ExecutionCheckpoint {
    return {
      kind: "missile_ship",
      data: {
        warshipId: this.warship?.id() ?? null,
        active: this.active,
        random: this.random.state(),
        pathfinder: this.pathfinder.snapshot(),
      } satisfies MissileShipExecutionCheckpoint,
    };
  }

  /** B2: overwrite this execution from a checkpoint. Returns false when the ship is missing. */
  restoreCheckpoint(game: Game, data: MissileShipExecutionCheckpoint): boolean {
    if (data.warshipId === null) return false;
    const warship = game.unit(data.warshipId);
    if (warship === undefined) return false;
    this.mg = game;
    this.warship = warship;
    this.active = data.active;
    this.random = new PseudoRandom(0);
    this.random.setState(data.random);
    this.pathfinder = new WaterPathFinder(
      game,
      data.pathfinder.stagger,
      data.pathfinder.memoized,
    );
    this.pathfinder.restore(data.pathfinder);
    return true;
  }

  init(mg: Game): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);

    if (isUnit(this.input)) {
      this.warship = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.MissileShip,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(
          `Failed to spawn MissileShip for ${this.input.owner.name()} at ${this.input.patrolTile}`,
        );
        this.active = false;
        return;
      }
      this.warship = this.input.owner.buildUnit(
        UnitType.MissileShip,
        spawn,
        this.input,
      );
    }
    this.random = new PseudoRandom(mg.ticks());
  }

  tick(): void {
    if (!this.warship || !this.warship.isActive()) {
      this.active = false;
      return;
    }

    // Reload missiles (also while fleeted)
    const frontTime = this.warship.missileTimerQueue()[0];
    if (frontTime !== undefined) {
      const cooldown =
        this.mg.config().SiloCooldown() - (this.mg.ticks() - frontTime);
      if (cooldown <= 0) {
        this.warship.reloadMissile();
      }
    }

    // Fleeted ships: only hold formation, no auto-behavior.
    if (this.warship.fleetId() !== undefined) {
      this.moveToPatrolTile();
      return;
    }

    // Patrol
    this.patrol();
  }

  private patrol(): void {
    const interval = shipMoveInterval(this.warship.type());
    if (this.mg.ticks() % interval !== 0) return;

    if (this.warship.targetTile() === undefined) {
      const tile = this.randomTile();
      if (tile !== undefined) {
        this.warship.setTargetTile(tile);
      }
    }
    const target = this.warship.targetTile();
    if (target === undefined) return;

    const result = this.pathfinder.next(this.warship.tile(), target);
    if (
      result.status === PathStatus.NEXT ||
      result.status === PathStatus.COMPLETE
    ) {
      this.warship.move(result.node);
    }
    if (result.status === PathStatus.COMPLETE) {
      this.warship.setTargetTile(undefined);
    }
  }

  private moveToPatrolTile(): void {
    const patrolTile = this.warship.warshipState().patrolTile;
    if (patrolTile === undefined) return;
    if (this.warship.tile() === patrolTile) return;

    const moveRate = this.warship.warshipState().fleetMoveRate ?? 1;
    if (moveRate > 1 && this.mg.ticks() % moveRate !== 0) return;

    const result = this.pathfinder.next(this.warship.tile(), patrolTile);
    if (
      result.status === PathStatus.NEXT ||
      result.status === PathStatus.COMPLETE
    ) {
      this.warship.move(result.node);
    }
  }

  private randomTile(): number | undefined {
    const patrolTile = this.warship.warshipState().patrolTile;
    const center = patrolTile ?? this.warship.tile();
    for (let i = 0; i < 20; i++) {
      const rx = this.random.nextInt(-50, 50);
      const ry = this.random.nextInt(-50, 50);
      const x = this.mg.x(center) + rx;
      const y = this.mg.y(center) + ry;
      if (this.mg.isValidCoord(x, y) && this.mg.isWater(this.mg.ref(x, y))) {
        return this.mg.ref(x, y);
      }
    }
    return undefined;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
