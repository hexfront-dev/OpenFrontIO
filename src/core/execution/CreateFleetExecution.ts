import { Execution, Game, MAX_FLEET_SIZE, Player, WarShips } from "../game/Game";
import { assignFleetFormation, computeFleetCentroid } from "./FleetFormation";

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

    if (fleetUnits.length > MAX_FLEET_SIZE) {
      this.active = false;
      return;
    }

    const fleetId = mg.nextFleetId();
    for (const unit of fleetUnits) {
      unit.setFleetId(fleetId);
    }

    // Form the fleet up in a grid around its centroid.
    assignFleetFormation(mg, fleetUnits, computeFleetCentroid(mg, fleetUnits));

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
