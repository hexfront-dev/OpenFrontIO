import { Execution, Game, MessageType, OwnerComp, Unit, UnitParams, UnitType, isUnit } from "../game/Game";
import { WaterPathFinder } from "../pathfinding/PathFinder";
import { PathStatus } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";
import { SAMTargetingSystem } from "./SAMLauncherExecution";
import { SAMMissileExecution } from "./SAMMissileExecution";

export class MissileDefenseShipExecution implements Execution {
  private active = true;
  private warship: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private random: PseudoRandom;
  private patrolMoveNext = true;
  private targetingSystem: SAMTargetingSystem | undefined;
  private readonly MIRV_SEARCH_RADIUS = 400;
  private readonly MIRV_PROTECTION_RADIUS = 50;

  constructor(
    private input: (UnitParams<UnitType.MissileDefenseShip> & OwnerComp) | Unit,
  ) {}

  init(mg: Game): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);

    if (isUnit(this.input)) {
      this.warship = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.MissileDefenseShip,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(
          `Failed to spawn MissileDefenseShip for ${this.input.owner.name()} at ${this.input.patrolTile}`,
        );
        this.active = false;
        return;
      }
      this.warship = this.input.owner.buildUnit(
        UnitType.MissileDefenseShip,
        spawn,
        this.input,
      );
    }
    this.random = new PseudoRandom(mg.ticks());
  }

  tick(ticks: number): void {
    if (!this.warship || !this.warship.isActive()) {
      this.active = false;
      return;
    }

    // Reload missiles (also while fleeted)
    const frontTime = this.warship.missileTimerQueue()[0];
    if (frontTime !== undefined) {
      const cooldown =
        this.mg.config().SAMCooldown() - (this.mg.ticks() - frontTime);
      if (cooldown <= 0) {
        this.warship.reloadMissile();
      }
    }

    // Fleeted ships: only hold formation, no auto-behavior.
    if (this.warship.fleetId() !== undefined) {
      this.moveToPatrolTile();
      return;
    }

    if (this.warship.isInCooldown()) {
      this.patrol();
      return;
    }

    this.targetingSystem ??= new SAMTargetingSystem(this.mg, this.warship);

    const owner = this.warship.owner();

    const mirvWarheadTargets = this.mg.nearbyUnits(
      this.warship.tile(),
      this.MIRV_SEARCH_RADIUS,
      UnitType.MIRVWarhead,
      ({ unit }) => {
        if (!isUnit(unit)) return false;
        if (unit.owner() === owner) return false;
        if (owner.isFriendly(unit.owner())) {
          if (
            this.mg.getWinner() === null ||
            !owner.isOnSameTeam(unit.owner())
          ) {
            return false;
          }
        }
        const dst = unit.targetTile();
        return (
          dst !== undefined &&
          this.mg.manhattanDist(dst, this.warship.tile()) <
            this.MIRV_PROTECTION_RADIUS
        );
      },
    );

    const target =
      mirvWarheadTargets.length === 0
        ? this.targetingSystem.getSingleTarget(ticks)
        : null;

    if (target || mirvWarheadTargets.length > 0) {
      this.warship.launch();
      const type =
        mirvWarheadTargets.length > 0
          ? UnitType.MIRVWarhead
          : target?.unit.type();
      if (type === undefined) throw new Error("Unknown unit type");
      if (mirvWarheadTargets.length > 0) {
        this.mg.displayMessage(
          "events_display.mirv_warheads_intercepted",
          MessageType.SAM_HIT,
          owner.id(),
          undefined,
          { count: mirvWarheadTargets.length },
        );
        mirvWarheadTargets.forEach(({ unit: u }) => {
          u.delete();
        });
        this.mg
          .stats()
          .bombIntercept(
            owner,
            UnitType.MIRVWarhead,
            mirvWarheadTargets.length,
          );
      } else if (target !== null) {
        target.unit.setTargetedBySAM(true);
        this.mg.addExecution(
          new SAMMissileExecution(
            this.warship.tile(),
            owner,
            this.warship,
            target.unit,
            target.tile,
          ),
        );
      } else {
        throw new Error("target is null");
      }
    }

    this.patrol();
  }

  private patrol(): void {
    this.patrolMoveNext = !this.patrolMoveNext;
    if (!this.patrolMoveNext) return;

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

  private moveToPatrolTile(): void {
    const patrolTile = this.warship.warshipState().patrolTile;
    if (patrolTile === undefined) return;
    if (this.warship.tile() === patrolTile) return;

    const moveRate = this.warship.warshipState().fleetMoveRate ?? 1;
    if (moveRate > 1 && this.mg.ticks() % moveRate !== 0) return;

    const result = this.pathfinder.next(this.warship.tile(), patrolTile);
    if (result.status === PathStatus.NEXT || result.status === PathStatus.COMPLETE) {
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
