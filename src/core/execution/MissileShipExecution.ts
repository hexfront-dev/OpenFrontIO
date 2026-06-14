import { Execution, Game, OwnerComp, Unit, UnitParams, UnitType, isUnit } from "../game/Game";
import { WaterPathFinder } from "../pathfinding/PathFinder";
import { PathStatus } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";

export class MissileShipExecution implements Execution {
  private active = true;
  private warship: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private random: PseudoRandom;

  constructor(
    private input: (UnitParams<UnitType.MissileShip> & OwnerComp) | Unit,
  ) {}

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

    // Fleeted ships: only patrol, no auto-behavior.
    if (this.warship.fleetId() !== undefined) {
      this.patrol();
      return;
    }

    // Reload missiles
    const config = this.mg.config();
    const timerQueue = this.warship.missileTimerQueue();
    if (timerQueue.length > 0) {
      const frontTime = timerQueue[0];
      const cooldown = config.SiloCooldown();
      if (this.mg.ticks() - frontTime > cooldown) {
        this.warship.reloadMissile();
      }
    }

    // Patrol
    this.patrol();
  }

  private patrol(): void {
    if (this.warship.targetTile() === undefined) {
      const tile = this.randomTile();
      if (tile !== undefined) {
        this.warship.setTargetTile(tile);
      }
    }
    const target = this.warship.targetTile();
    if (target === undefined) return;

    const result = this.pathfinder.next(this.warship.tile(), target);
    if (result.status === PathStatus.NEXT || result.status === PathStatus.COMPLETE) {
      this.warship.move(result.node);
    }
    if (result.status === PathStatus.COMPLETE) {
      this.warship.setTargetTile(undefined);
    }
  }

  private randomTile(): number | undefined {
    const tile = this.warship.tile();
    for (let i = 0; i < 20; i++) {
      const rx = this.random.nextInt(-50, 50);
      const ry = this.random.nextInt(-50, 50);
      const x = this.mg.x(tile) + rx;
      const y = this.mg.y(tile) + ry;
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
