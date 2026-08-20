import { Execution, Game, Player, Unit, UnitType } from "../game/Game";
import { TrainStationExecution } from "./TrainStationExecution";

export class DisableTrainStationExecution implements Execution {
  private unit: Unit | undefined;
  private active = true;

  constructor(
    private player: Player,
    private unitId: number,
  ) {}

  init(mg: Game): void {
    this.unit = mg.unit(this.unitId);
    if (!this.unit) {
      console.warn(`unit not found`);
      this.active = false;
      return;
    }

    if (this.unit.owner() !== this.player) {
      console.warn(`unit not owned by player`);
      this.active = false;
      return;
    }

    if (
      this.unit.type() !== UnitType.Factory &&
      this.unit.type() !== UnitType.City &&
      this.unit.type() !== UnitType.Port
    ) {
      console.warn(`unit cannot have a train station`);
      this.active = false;
      return;
    }

    // Toggle: disconnect if connected, reconnect if disconnected.
    if (this.unit.hasTrainStation()) {
      mg.railNetwork().removeStation(this.unit);
    } else {
      const spawnTrains = this.unit.type() === UnitType.Factory;
      mg.addExecution(new TrainStationExecution(this.unit, spawnTrains));
    }
    this.active = false;
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
