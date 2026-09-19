import { ExecutionCheckpoint } from "../Checkpoint";
import { Execution, Game, Unit } from "../game/Game";
import { ShellExecution } from "./ShellExecution";

export class DefensePostExecution implements Execution {
  private mg: Game;
  private active: boolean = true;

  private target: Unit | null = null;
  private lastShellAttack = 0;

  private alreadySentShell = new Set<Unit>();

  constructor(private post: Unit) {}

  checkpoint(): ExecutionCheckpoint {
    return {
      kind: "defense_post",
      data: {
        postId: this.post.id(),
        active: this.active,
        targetId: this.target?.id() ?? null,
        lastShellAttack: this.lastShellAttack,
        alreadySentShellIds: Array.from(this.alreadySentShell).map((u) =>
          u.id(),
        ),
      },
    };
  }

  restoreCheckpoint(data: {
    postId: number;
    active: boolean;
    targetId: number | null;
    lastShellAttack: number;
    alreadySentShellIds: number[];
  }): void {
    this.active = data.active;
    this.target =
      data.targetId !== null ? (this.mg.unit(data.targetId) ?? null) : null;
    this.lastShellAttack = data.lastShellAttack;
    this.alreadySentShell = new Set(
      data.alreadySentShellIds
        .map((id) => this.mg.unit(id))
        .filter((u): u is Unit => u !== undefined),
    );
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  private shoot() {
    if (this.target === null) return;
    const shellAttackRate = this.mg.config().defensePostShellAttackRate();
    if (this.mg.ticks() - this.lastShellAttack > shellAttackRate) {
      this.lastShellAttack = this.mg.ticks();
      this.mg.addExecution(
        new ShellExecution(
          this.post.tile(),
          this.post.owner(),
          this.post,
          this.target,
        ),
      );
      if (!this.target.hasHealth()) {
        // Don't send multiple shells to target that can be oneshotted
        this.alreadySentShell.add(this.target);
        this.target = null;
        return;
      }
    }
  }

  tick(ticks: number): void {
    if (!this.post.isActive()) {
      this.active = false;
      return;
    }

    // Complete an upgrade's construction once its build time elapses.
    this.post.maybeFinishDefensePostUpgrade(ticks);

    // Do nothing while the structure is under construction
    if (this.post.isUnderConstruction()) {
      return;
    }

    if (this.target !== null && !this.target.isActive()) {
      this.target = null;
    }

    // TODO: Reconsider how/if defense posts target ships.
    // const ships = this.mg
    //   .nearbyUnits(
    //     this.post.tile(),
    //     this.mg.config().defensePostTargettingRange(),
    //     [UnitType.TransportShip, UnitType.Warship],
    //   )
    //   .filter(
    //     ({ unit }) =>
    //       this.post !== null &&
    //       unit.owner() !== this.post.owner() &&
    //       !unit.owner().isFriendly(this.post.owner()) &&
    //       !this.alreadySentShell.has(unit),
    //   );
    //
    // this.target =
    //   ships.sort((a, b) => {
    //     const { unit: unitA, distSquared: distA } = a;
    //     const { unit: unitB, distSquared: distB } = b;
    //
    //     // Prioritize TransportShip
    //     if (
    //       unitA.type() === UnitType.TransportShip &&
    //       unitB.type() !== UnitType.TransportShip
    //     )
    //       return -1;
    //     if (
    //       unitA.type() !== UnitType.TransportShip &&
    //       unitB.type() === UnitType.TransportShip
    //     )
    //       return 1;
    //
    //     // If both are the same type, sort by distance (lower `distSquared` means closer)
    //     return distA - distB;
    //   })[0]?.unit ?? null;
    //
    // if (this.target === null || !this.target.isActive()) {
    //   this.target = null;
    //   return;
    // } else {
    //   this.shoot();
    //   return;
    // }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
