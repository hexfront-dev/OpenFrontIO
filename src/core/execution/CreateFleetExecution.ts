import { Execution, Game, Player, UnitType, WarShips } from "../game/Game";

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
          WarShips.has(u.type()) &&
          u.owner() === this.player &&
          u.isActive(),
      );

    if (fleetUnits.length === 0) {
      this.active = false;
      return;
    }

    const fleetId = mg.nextFleetId();
    const fleetMoveRate = Math.max(
      ...fleetUnits.map((u) => (u.type() === UnitType.Warship ? 2 : 1)),
    );
    for (const unit of fleetUnits) {
      unit.setFleetId(fleetId);
      unit.updateWarshipState({ fleetMoveRate });
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
