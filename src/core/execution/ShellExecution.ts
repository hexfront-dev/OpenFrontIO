import { ExecutionCheckpoint } from "../Checkpoint";
import {
  Execution,
  Game,
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
import { PseudoRandom, PseudoRandomState } from "../PseudoRandom";

export interface ShellExecutionCheckpoint {
  spawn: TileRef;
  ownerId: PlayerID;
  ownerUnitId: number;
  targetId: number;
  active: boolean;
  shellId: number | null;
  destroyAtTick: number;
  random: PseudoRandomState;
  pathFinder: PathFinderStepperSnapshot<TileRef>;
}

export class ShellExecution implements Execution {
  private active = true;
  private pathFinder: PathFinderStepper<TileRef>;
  private shell: Unit | undefined;
  private mg: Game;
  private destroyAtTick: number = -1;
  private random: PseudoRandom;

  constructor(
    private spawn: TileRef,
    private _owner: Player,
    private ownerUnit: Unit,
    private target: Unit,
  ) {}

  /** B2: capture the shell's in-flight route, PRNG and lifetime state. */
  checkpoint(): ExecutionCheckpoint {
    return {
      kind: "shell",
      data: {
        spawn: this.spawn,
        ownerId: this._owner.id(),
        ownerUnitId: this.ownerUnit.id(),
        targetId: this.target.id(),
        active: this.active,
        shellId: this.shell?.id() ?? null,
        destroyAtTick: this.destroyAtTick,
        random: this.random.state(),
        pathFinder: this.pathFinder.snapshot(),
      } satisfies ShellExecutionCheckpoint,
    };
  }

  /** B2: overwrite this execution from a checkpoint. Returns false if a referenced unit is gone. */
  restoreCheckpoint(game: Game, data: ShellExecutionCheckpoint): boolean {
    const ownerUnit = game.unit(data.ownerUnitId);
    const target = game.unit(data.targetId);
    if (ownerUnit === undefined || target === undefined) return false;
    const shell = data.shellId === null ? undefined : game.unit(data.shellId);
    if (data.shellId !== null && shell === undefined) return false;

    this.mg = game;
    this.active = data.active;
    this.spawn = data.spawn;
    this._owner = game.player(data.ownerId);
    this.ownerUnit = ownerUnit;
    this.target = target;
    this.shell = shell;
    this.destroyAtTick = data.destroyAtTick;
    this.random = new PseudoRandom(0);
    this.random.setState(data.random);
    this.pathFinder = PathFinding.Air(game);
    this.pathFinder.restore(data.pathFinder);
    return true;
  }

  init(mg: Game, ticks: number): void {
    this.pathFinder = PathFinding.Air(mg);
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks());
  }

  tick(ticks: number): void {
    this.shell ??= this._owner.buildUnit(UnitType.Shell, this.spawn, {});
    if (!this.shell.isActive()) {
      this.active = false;
      return;
    }
    if (
      !this.target.isActive() ||
      this.target.owner() === this.shell.owner() ||
      (this.destroyAtTick !== -1 && this.mg.ticks() >= this.destroyAtTick)
    ) {
      this.shell.delete(false);
      this.active = false;
      return;
    }

    if (this.destroyAtTick === -1 && !this.ownerUnit.isActive()) {
      this.destroyAtTick = this.mg.ticks() + this.mg.config().shellLifetime();
    }

    const speed = this.mg.config().warshipShellSpeed();
    for (let i = 0; i < speed; i++) {
      const result = this.pathFinder.next(
        this.shell.tile(),
        this.target.tile(),
      );
      if (result.status === PathStatus.COMPLETE) {
        this.active = false;
        const targetType = this.target.type();
        const targetWasActive = this.target.isActive();
        this.target.modifyHealth(-this.effectOnTarget(), this._owner);
        // Award veterancy to the firing warship when this shell lands the
        // killing blow on an enemy warship or transport ship.
        if (
          targetWasActive &&
          !this.target.isActive() &&
          this.ownerUnit.isActive() &&
          this.ownerUnit.type() === UnitType.Warship
        ) {
          this.ownerUnit.recordKill(targetType);
        }
        this.shell.setReachedTarget();
        this.shell.delete(false);
        return;
      } else if (result.status === PathStatus.NEXT) {
        this.shell.move(result.node);
      }
    }
  }

  private effectOnTarget(): number {
    const { damage } = this.mg.config().unitInfo(UnitType.Shell);
    const baseDamage = damage ?? 250;

    const roll = this.random.nextInt(1, 6);
    let damageMultiplier = (roll - 1) * 25 + 200;

    // Veteran warships hit harder — scale the (integer) multiplier by the firing
    // unit's veterancy. Integer percent math keeps src/core float-free.
    const veterancy = this.ownerUnit.veterancy();
    if (veterancy > 0) {
      const bonusPercent = this.mg.config().warshipVeterancyShellDamageBonus();
      damageMultiplier = Math.floor(
        (damageMultiplier * (100 + veterancy * bonusPercent)) / 100,
      );
    }

    return Math.round((baseDamage / 250) * damageMultiplier);
  }

  public getEffectOnTargetForTesting(): number {
    return this.effectOnTarget();
  }

  isActive(): boolean {
    return this.active;
  }
  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
