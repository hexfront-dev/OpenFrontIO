import {
  ExecutionCheckpoint,
  TrainStationExecutionCheckpoint,
} from "../Checkpoint";
import { Execution, Game, Unit, UnitType } from "../game/Game";
import { TrainStation } from "../game/TrainStation";
import { PseudoRandom } from "../PseudoRandom";
import { TrainExecution } from "./TrainExecution";

export class TrainStationExecution implements Execution {
  private mg: Game;
  private active: boolean = true;
  private random: PseudoRandom;
  private station: TrainStation | null = null;
  private numCars: number = 5;
  private lastSpawnTick: number = 0;
  private ticksCooldown: number = 10; // Minimum cooldown between two trains
  constructor(
    private unit: Unit,
    private spawnTrains?: boolean, // If set, the station will spawn trains
  ) {
    this.unit.setTrainStation(true);
  }

  isActive(): boolean {
    return this.active;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (this.spawnTrains) {
      this.random = new PseudoRandom(mg.ticks());
    }
  }

  tick(ticks: number): void {
    if (this.mg === undefined) {
      throw new Error("Not initialized");
    }
    if (!this.isActive() || this.unit === undefined) {
      return;
    }
    if (this.station === null) {
      // Can't create new executions on init, so it has to be done in the tick
      this.station = new TrainStation(this.mg, this.unit);
      this.mg.railNetwork().connectStation(this.station);
    }
    if (!this.station.isActive()) {
      this.active = false;
      return;
    }
    if (this.spawnTrains) {
      this.spawnTrain(this.station, ticks);
    }
  }

  private shouldSpawnTrain(): boolean {
    const spawnRate = this.mg
      .config()
      .trainSpawnRate(this.unit.owner().unitCount(UnitType.Factory));
    for (let i = 0; i < this.unit!.level(); i++) {
      if (this.random.chance(spawnRate)) {
        return true;
      }
    }
    return false;
  }

  private spawnTrain(station: TrainStation, currentTick: number) {
    if (this.mg === undefined) throw new Error("Not initialized");
    if (!this.spawnTrains) return;
    if (this.random === undefined) throw new Error("Not initialized");
    if (currentTick < this.lastSpawnTick + this.ticksCooldown) return;
    const cluster = station.getCluster();
    if (cluster === null) {
      return;
    }
    const owner = this.unit.owner();
    if (!cluster.hasAnyTradeDestination(owner)) {
      return;
    }
    if (!this.shouldSpawnTrain()) {
      return;
    }

    // Pick a destination randomly.
    // Could be improved to pick a lucrative trip
    const destination = cluster.randomTradeDestination(owner, this.random);
    if (destination === null) return;
    if (destination === station) return;

    this.mg.addExecution(
      new TrainExecution(
        this.mg.railNetwork(),
        owner,
        station,
        destination,
        this.numCars,
      ),
    );
    this.lastSpawnTick = currentTick;
  }

  checkpoint(): ExecutionCheckpoint {
    return {
      kind: "train_station",
      data: {
        unitId: this.unit.id(),
        spawnTrains: this.spawnTrains ?? false,
        active: this.active,
        stationId: this.station?.id ?? null,
        numCars: this.numCars,
        lastSpawnTick: this.lastSpawnTick,
        ticksCooldown: this.ticksCooldown,
        random: this.spawnTrains ? this.random.state() : null,
      } satisfies TrainStationExecutionCheckpoint,
    };
  }

  restoreCheckpoint(game: Game, data: TrainStationExecutionCheckpoint): void {
    this.active = data.active;
    this.numCars = data.numCars;
    this.lastSpawnTick = data.lastSpawnTick;
    this.ticksCooldown = data.ticksCooldown;
    this.station =
      data.stationId === null
        ? null
        : (game.railNetwork().stationManager().getById(data.stationId) ?? null);
    if (this.spawnTrains && data.random !== null) {
      this.random.setState(data.random);
    }
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
