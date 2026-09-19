import { ExecutionCheckpoint } from "../Checkpoint";
import { Execution, Game, Unit, UnitType } from "../game/Game";
import { TrainStationExecution } from "./TrainStationExecution";

export class CityExecution implements Execution {
  private mg: Game;
  private active: boolean = true;
  private stationCreated = false;

  constructor(private city: Unit) {}

  checkpoint(): ExecutionCheckpoint {
    return {
      kind: "city",
      data: {
        cityId: this.city.id(),
        stationCreated: this.stationCreated,
        active: this.active,
      },
    };
  }

  restoreCheckpoint(data: {
    cityId: number;
    stationCreated: boolean;
    active: boolean;
  }): void {
    this.stationCreated = data.stationCreated;
    this.active = data.active;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.stationCreated) {
      this.createStation();
      this.stationCreated = true;
    }
    if (!this.city.isActive()) {
      this.active = false;
      return;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  private createStation(): void {
    const nearbyFactory = this.mg.hasUnitNearby(
      this.city.tile()!,
      this.mg.config().trainStationMaxRange(),
      UnitType.Factory,
    );
    if (nearbyFactory) {
      this.mg.addExecution(new TrainStationExecution(this.city));
    }
  }
}
