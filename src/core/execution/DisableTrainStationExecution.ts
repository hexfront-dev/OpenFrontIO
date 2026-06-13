import { Execution, Game, Player, Unit } from "../game/Game";

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

    if (!this.unit.hasTrainStation()) {
      console.warn(`unit does not have a train station`);
      this.active = false;
      return;
    }

    mg.railNetwork().removeStation(this.unit);
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
