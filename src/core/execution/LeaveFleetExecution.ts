import { Execution, Game, Player, UnitType } from "../game/Game";

export class LeaveFleetExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private unitIds: number[],
  ) {}

  init(mg: Game): void {
    for (const id of this.unitIds) {
      const unit = mg.unit(id);
      if (
        unit &&
        (unit.type() === UnitType.Warship ||
          unit.type() === UnitType.MissileShip ||
          unit.type() === UnitType.MissileDefenseShip) &&
        unit.owner() === this.player &&
        unit.isActive() &&
        unit.fleetId() !== undefined
      ) {
        unit.setFleetId(undefined);
      }
    }
    this.active = false;
  }

  tick(): void {}

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
