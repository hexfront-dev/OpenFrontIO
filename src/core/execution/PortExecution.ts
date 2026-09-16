import { Execution, Game, Unit, UnitType } from "../game/Game";
import { PseudoRandom } from "../PseudoRandom";
import { TradeShipExecution } from "./TradeShipExecution";
import { TrainStationExecution } from "./TrainStationExecution";

export class PortExecution implements Execution {
  private active = true;
  private mg: Game;
  private port: Unit;
  private random: PseudoRandom;
  private checkOffset: number;
  private tradeShipSpawnRejections = 0;
  private stationCreated = false;

  constructor(port: Unit) {
    this.port = port;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks());
    this.checkOffset = mg.ticks() % 10;
  }

  tick(ticks: number): void {
    if (this.mg === null || this.random === null || this.checkOffset === null) {
      throw new Error("Not initialized");
    }

    if (!this.port.isActive()) {
      this.active = false;
      return;
    }

    if (this.port.isUnderConstruction()) {
      return;
    }

    if (!this.stationCreated && !this.port.hasTrainStation()) {
      this.createStation();
      this.stationCreated = true;
    }

    // Only check every 10 ticks for performance.
    if ((this.mg.ticks() + this.checkOffset) % 10 !== 0) {
      return;
    }

    if (!this.shouldSpawnTradeShip()) {
      return;
    }

    const port = this.pickTradeDestination(
      this.tradingPorts(),
      this.ownNationPorts(),
    );

    if (port === null) {
      return;
    }

    this.mg.addExecution(
      new TradeShipExecution(this.port.owner(), this.port, port),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  shouldSpawnTradeShip(): boolean {
    const numTradeShips = this.mg.unitCount(UnitType.TradeShip);
    for (let i = 0; i < this.port!.level(); i++) {
      const spawnRate = this.mg
        .config()
        .tradeShipSpawnRate(this.tradeShipSpawnRejections, numTradeShips);
      if (this.random.chance(spawnRate)) {
        this.tradeShipSpawnRejections = 0;
        return true;
      }
      this.tradeShipSpawnRejections++;
    }
    return false;
  }

  createStation(): void {
    const nearbyFactory = this.mg.hasUnitNearby(
      this.port.tile()!,
      this.mg.config().trainStationMaxRange(),
      UnitType.Factory,
    );
    if (nearbyFactory) {
      this.mg.addExecution(new TrainStationExecution(this.port));
    }
  }

  private waterComponents(): Set<number> {
    const sourceComponents = new Set<number>();
    for (const neighbor of this.mg.neighbors(this.port!.tile())) {
      if (!this.mg.isWater(neighbor)) continue;
      const comp = this.mg.getWaterComponent(neighbor);
      if (comp !== null) sourceComponents.add(comp);
    }
    return sourceComponents;
  }

  private sharesWaterComponent(
    port: Unit,
    sourceComponents: Set<number>,
  ): boolean {
    for (const comp of sourceComponents) {
      if (this.mg.hasWaterComponent(port.tile(), comp)) return true;
    }
    return false;
  }

  // It's a probability list, so if an element appears twice it's because it's
  // twice more likely to be picked later.
  tradingPorts(): Unit[] {
    const sourceComponents = this.waterComponents();
    const ports = this.mg
      .players()
      .filter((p) => p !== this.port!.owner() && p.canTrade(this.port!.owner()))
      .flatMap((p) => p.units(UnitType.Port))
      .filter((p) => this.sharesWaterComponent(p, sourceComponents))
      .sort((p1, p2) => {
        return (
          this.mg.manhattanDist(this.port!.tile(), p1.tile()) -
          this.mg.manhattanDist(this.port!.tile(), p2.tile())
        );
      });

    const weightedPorts: Unit[] = [];

    for (const [i, otherPort] of ports.entries()) {
      const expanded = new Array(otherPort.level()).fill(otherPort);
      weightedPorts.push(...expanded);
      const tooClose =
        this.mg.manhattanDist(this.port!.tile(), otherPort.tile()) <
        this.mg.config().tradeShipShortRangeDebuff();
      const closeBonus =
        i < this.mg.config().proximityBonusPortsNb(ports.length);
      if (!tooClose && closeBonus) {
        // If the port is close, but not too close, add it again
        // to increase the chances of trading with it.
        weightedPorts.push(...expanded);
      }
      if (!tooClose && this.port!.owner().isFriendly(otherPort.owner())) {
        weightedPorts.push(...expanded);
      }
    }
    return weightedPorts;
  }

  // Other ports owned by the same player. These are valid trade destinations,
  // but at half the weight of an equivalent foreign port.
  ownNationPorts(): Unit[] {
    const owner = this.port!.owner();
    const sourceComponents = this.waterComponents();
    const weightedPorts: Unit[] = [];

    for (const port of owner.units(UnitType.Port)) {
      if (port === this.port) continue;
      if (
        !port.isActive() ||
        port.isMarkedForDeletion() ||
        port.isUnderConstruction()
      ) {
        continue;
      }
      if (!this.sharesWaterComponent(port, sourceComponents)) continue;
      weightedPorts.push(...new Array(port.level()).fill(port));
    }
    return weightedPorts;
  }

  // Each foreign port occupies two slots and each same-nation port one, making
  // a same-nation port half as likely to be selected.
  private pickTradeDestination(
    foreignPorts: Unit[],
    ownPorts: Unit[],
  ): Unit | null {
    const foreignSlots = foreignPorts.length * 2;
    const totalSlots = foreignSlots + ownPorts.length;
    if (totalSlots === 0) {
      return null;
    }
    const roll = this.random.nextInt(0, totalSlots);
    if (roll < foreignSlots) {
      return foreignPorts[roll >> 1];
    }
    return ownPorts[roll - foreignSlots];
  }
}
