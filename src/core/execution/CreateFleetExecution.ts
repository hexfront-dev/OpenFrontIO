import { Execution, Game, Player, UnitType } from "../game/Game";

export class CreateFleetExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private unitIds: number[],
  ) {}

  init(mg: Game): void {
    const fleetUnits = this.unitIds
      .map((id) => mg.unit(id))
      .filter(
        (u): u is NonNullable<typeof u> =>
          u !== undefined &&
          (u.type() === UnitType.Warship ||
            u.type() === UnitType.MissileShip ||
            u.type() === UnitType.MissileDefenseShip) &&
          u.owner() === this.player &&
          u.isActive(),
      );

    if (fleetUnits.length === 0) {
      this.active = false;
      return;
    }

    const fleetId = mg.nextFleetId();
    for (const unit of fleetUnits) {
      unit.setFleetId(fleetId);
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
