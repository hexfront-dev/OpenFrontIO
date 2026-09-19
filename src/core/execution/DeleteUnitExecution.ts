import { ExecutionCheckpoint } from "../Checkpoint";
import { Execution, Game, MessageType, Player, Unit } from "../game/Game";

export interface DeleteUnitExecutionCheckpoint {
  playerId: string;
  unitId: number;
  active: boolean;
}

export class DeleteUnitExecution implements Execution {
  private active: boolean = true;
  private mg: Game;
  private unit: Unit | null = null;

  constructor(
    private player: Player,
    private unitId: number,
  ) {}

  /** B2: capture the pending voluntary deletion. */
  checkpoint(): ExecutionCheckpoint {
    return {
      kind: "delete_unit",
      data: {
        playerId: this.player.id(),
        unitId: this.unitId,
        active: this.active,
      } satisfies DeleteUnitExecutionCheckpoint,
    };
  }

  /** B2: overwrite from a checkpoint (never re-runs init's validation/side effects). */
  restoreCheckpoint(game: Game, data: DeleteUnitExecutionCheckpoint): void {
    this.mg = game;
    this.active = data.active;
    this.unit = game.unit(data.unitId) ?? null;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number) {
    if (!this.active) {
      return;
    }
    this.mg = mg;

    const unit = this.mg.unit(this.unitId);
    if (!unit || unit.owner() !== this.player) {
      console.warn(
        `SECURITY: unit ${this.unitId} not found or not owned by player ${this.player.displayName()}`,
      );
      this.active = false;
      return;
    }

    if (!unit.isActive()) {
      console.warn(`SECURITY: unit ${this.unitId} is not active`);
      this.active = false;
      return;
    }
    this.unit = unit;

    const tileOwner = mg.owner(unit.tile());
    if (!tileOwner.isPlayer() || tileOwner.id() !== this.player.id()) {
      console.warn(
        `SECURITY: unit ${this.unitId} is not on player's territory`,
      );
      this.active = false;
      return;
    }

    if (!mg.isLand(unit.tile())) {
      console.warn(`SECURITY: unit ${this.unitId} is not on land`);
      this.active = false;
      return;
    }

    if (mg.inSpawnPhase()) {
      console.warn(`SECURITY: cannot delete units during spawn phase`);
      this.active = false;
      return;
    }

    if (!this.player.canDeleteUnit()) {
      console.warn(`SECURITY: delete unit cooldown not expired`);
      this.active = false;
      return;
    }

    this.player.recordDeleteUnit();
    unit.markForDeletion();
  }

  tick(ticks: number) {
    if (!this.active || !this.unit) {
      return;
    }
    if (!this.unit.isActive()) {
      this.active = false;
      return;
    }
    if (this.unit.isOverdueDeletion()) {
      this.unit.delete(false);

      this.mg.displayMessage(
        `events_display.unit_voluntarily_deleted`,
        MessageType.UNIT_DESTROYED,
        this.player.id(),
      );
      this.active = false;
    }
  }

  isActive(): boolean {
    return this.active;
  }
}
