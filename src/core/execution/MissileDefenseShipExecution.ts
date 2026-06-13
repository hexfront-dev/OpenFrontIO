import { Execution, Game, MessageType, Unit, UnitType } from "../game/Game";
import { WaterPathFinder } from "../pathfinding/PathFinder";
import { PathStatus } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";

export class MissileDefenseShipExecution implements Execution {
  private active = true;
  private warship: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private random: PseudoRandom;
  private readonly MIRV_SEARCH_RADIUS = 400;
  private readonly MIRV_PROTECTION_RADIUS = 50;

  constructor(warship: Unit) {
    this.warship = warship;
  }

  init(mg: Game): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    this.random = new PseudoRandom(mg.ticks());
  }

  tick(): void {
    if (!this.warship.isActive()) {
      this.active = false;
      return;
    }

    // Reload missiles
    const timerQueue = this.warship.missileTimerQueue();
    if (timerQueue.length > 0) {
      const frontTime = timerQueue[0];
      const cooldown = this.mg.config().SAMCooldown();
      if (this.mg.ticks() - frontTime > cooldown) {
        this.warship.reloadMissile();
      }
    }

    // Intercept nearby MIRV warheads
    this.interceptMIRV();

    this.patrol();
  }

  private interceptMIRV(): void {
    const owner = this.warship.owner();
    const warheads = this.mg.nearbyUnits(
      this.warship.tile(),
      this.MIRV_SEARCH_RADIUS,
      [UnitType.MIRVWarhead],
    );
    for (const { unit } of warheads) {
      if (unit.owner() === owner) continue;
      if (!owner.canAttackPlayer(unit.owner(), true)) continue;
      const dist = this.mg.manhattanDist(this.warship.tile(), unit.tile());
      if (dist > this.MIRV_PROTECTION_RADIUS) continue;
      unit.delete();
    }
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
