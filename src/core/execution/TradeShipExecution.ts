import { renderNumber } from "../../client/Utils";
import {
  Execution,
  Game,
  Gold,
  MessageType,
  Player,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { WaterPathFinder } from "../pathfinding/PathFinder";
import { PathStatus } from "../pathfinding/types";
import { findClosestBy } from "../Util";

export class TradeShipExecution implements Execution {
  private active = true;
  private mg: Game;
  private tradeShip: Unit | undefined;
  private wasCaptured = false;
  private pathFinder: WaterPathFinder;
  private tilesTraveled = 0;
  private motionPlanId = 1;
  private motionPlanDst: TileRef | null = null;

  private static _staggerCounter = 0;

  constructor(
    private origOwner: Player,
    private srcPort: Unit,
    private _dstPort: Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    const stagger =
      TradeShipExecution._staggerCounter++ % WaterPathFinder.STAGGER_SPREAD;
    this.pathFinder = new WaterPathFinder(mg, stagger, true); // memoized: port tile to port tile repeats
  }

  tick(ticks: number): void {
    if (this.pathFinder.rebuilt) {
      this.motionPlanDst = null; // Force motion plan re-recording
    }

    if (this.tradeShip === undefined) {
      const spawn = this.origOwner.canBuild(
        UnitType.TradeShip,
        this.srcPort.tile(),
      );
      if (spawn === false) {
        console.warn(`cannot build trade ship`);
        this.active = false;
        return;
      }
      this.tradeShip = this.origOwner.buildUnit(UnitType.TradeShip, spawn, {
        targetUnit: this._dstPort,
        lastSetSafeFromPirates: ticks,
      });
      this.mg.stats().boatSendTrade(this.origOwner, this._dstPort.owner());
    }

    if (!this.tradeShip.isActive()) {
      this.active = false;
      return;
    }

    const tradeShipOwner = this.tradeShip.owner();
    const dstPortOwner = this._dstPort.owner();
    if (this.wasCaptured !== true && this.origOwner !== tradeShipOwner) {
      // Store as variable in case ship is recaptured by previous owner
      this.wasCaptured = true;
      this.mg.displayMessage(
        "events_display.trade_ship_captured",
        MessageType.UNIT_DESTROYED,
        this.origOwner.id(),
        undefined,
        { name: tradeShipOwner.displayName() },
        this.tradeShip.id(),
        tradeShipOwner.id(),
      );
    }

    // A ship may legitimately trade with another port of its own nation, so a
    // destination owned by the source owner is no longer invalid.
    const sameNation = tradeShipOwner.id() === dstPortOwner.id();

    if (
      !this.wasCaptured &&
      (!this._dstPort.isActive() ||
        (!sameNation && !tradeShipOwner.canTrade(dstPortOwner)))
    ) {
      this.tradeShip.delete(false);
      this.active = false;
      return;
    }

    const curTile = this.tradeShip.tile();

    if (
      this.wasCaptured &&
      (tradeShipOwner !== dstPortOwner || !this._dstPort.isActive())
    ) {
      const myComponent = this.mg.getWaterComponent(curTile);
      const nearestPort = findClosestBy(
        tradeShipOwner.units(UnitType.Port),
        (port) => this.mg.manhattanDist(port.tile(), curTile),
        (port) =>
          port.isActive() &&
          !port.isMarkedForDeletion() &&
          !port.isUnderConstruction() &&
          myComponent !== null &&
          this.mg.hasWaterComponent(port.tile(), myComponent),
      );
      if (nearestPort === null) {
        this.tradeShip.delete(false);
        this.active = false;
        return;
      } else {
        this._dstPort = nearestPort;
        this.tradeShip.setTargetUnit(this._dstPort);
        // Plan-driven units don't emit per-tick unit updates, so force a sync for the new target.
        this.tradeShip.touch();
      }
    }

    // A ship may pass through several tolling nations on one trip. Each nation
    // can tax it at most once, and each Tollhouse only so many ships per
    // cooldown window. The gold is actually deducted at completion.
    this.applyTolls(ticks);

    if (curTile === this.dstPort()) {
      this.complete();
      return;
    }

    const dst = this._dstPort.tile();
    const result = this.pathFinder.next(curTile, dst);

    switch (result.status) {
      case PathStatus.NEXT:
        if (dst !== this.motionPlanDst) {
          this.motionPlanId++;
          const from = result.node;
          const path = this.pathFinder.pathForTraversal(from, dst);

          this.mg.recordMotionPlan({
            kind: "grid",
            unitId: this.tradeShip.id(),
            planId: this.motionPlanId,
            startTick: ticks + 1,
            ticksPerStep: 1,
            path,
          });
          this.motionPlanDst = dst;
        }
        // Update safeFromPirates status
        if (this.mg.isWater(result.node) && this.mg.isShoreline(result.node)) {
          this.tradeShip.setSafeFromPirates();
        }
        this.tradeShip.move(result.node);
        this.tilesTraveled++;
        break;
      case PathStatus.COMPLETE:
        this.complete();
        return;
      case PathStatus.NOT_FOUND:
        console.warn("captured trade ship cannot find route");
        if (this.tradeShip.isActive()) {
          this.tradeShip.delete(false);
        }
        this.active = false;
        return;
    }
  }

  /**
   * Register every Tollhouse whose range currently covers the ship. Only one
   * toll per tolling nation is recorded; each Tollhouse spends one unit of its
   * per-window capacity. Gold is not moved here — the ship's value is only
   * known once it arrives, so the toll is settled in complete().
   */
  private applyTolls(ticks: number): void {
    const ship = this.tradeShip!;
    const owner = ship.owner();
    const curTile = ship.tile();
    const tollhouses = this.mg.nearbyUnits(
      curTile,
      this.mg.config().tollhouseMaxRange(),
      UnitType.Tollhouse,
    );

    for (const { unit, distSquared } of tollhouses) {
      const tollOwner = unit.owner();
      if (tollOwner === owner) continue;
      const range = this.mg.config().tollhouseRange(unit.level());
      if (distSquared > range * range) continue;
      const percent = tollOwner.tollRateFor(owner);
      if (percent <= 0) continue;
      if (ship.hasTollFrom(tollOwner.smallID())) continue;
      if (!unit.canTollShip(ticks)) continue;
      ship.addToll(tollOwner.smallID(), percent, unit.tile());
      unit.recordToll(ticks);
    }
  }

  /**
   * Pay each registered toller a percentage of the ship's gross value and
   * return what is left for the trade's normal split. Each toll is computed
   * from the gross value (so stacking tolls don't compound), clamped so the
   * total never exceeds the ship's worth.
   */
  private deductTolls(gross: Gold): Gold {
    let remaining = gross;
    for (const toll of this.tradeShip!.tolls()) {
      const toller = this.mg.playerBySmallID(toll.tollerSmallID);
      if (!toller.isPlayer()) continue;
      const share = (gross * BigInt(toll.percent)) / 100n;
      const taken = share > remaining ? remaining : share;
      if (taken <= 0n) continue;
      remaining -= taken;
      toller.addGold(taken, toll.tile);
    }
    return remaining;
  }

  private complete() {
    this.active = false;
    this.tradeShip!.delete(false);
    const gross = this.mg
      .config()
      .tradeShipGold(this.tilesTraveled, this.tradeShip!.owner());
    const gold = this.deductTolls(gross);

    if (this.wasCaptured) {
      this.tradeShip!.owner().addGold(gold, this._dstPort.tile());
      this.tradeShip!.owner().addPiracyGold(gold);
      this.mg.displayMessage(
        "events_display.received_gold_from_captured_ship",
        MessageType.CAPTURED_ENEMY_UNIT,
        this.tradeShip!.owner().id(),
        gold,
        {
          gold: renderNumber(gold),
          name: this.origOwner.displayName(),
        },
        undefined,
        this.origOwner.id(),
      );
      // Record stats
      this.mg
        .stats()
        .boatCapturedTrade(this.tradeShip!.owner(), this.origOwner, gold);
    } else {
      const srcOwner = this.srcPort.owner();
      const dstOwner = this._dstPort.owner();
      if (srcOwner.id() === dstOwner.id()) {
        // Trading with your own nation yields half as much gold, paid once.
        const sameNationGold = gold / 2n;
        srcOwner.addGold(sameNationGold, this.srcPort.tile());
        srcOwner.addTradeGold(sameNationGold);
        this.mg.stats().boatArriveTrade(srcOwner, dstOwner, sameNationGold);
      } else {
        srcOwner.addGold(gold, this.srcPort.tile());
        dstOwner.addGold(gold, this._dstPort.tile());
        srcOwner.addTradeGold(gold);
        dstOwner.addTradeGold(gold);
        // Record stats
        this.mg.stats().boatArriveTrade(srcOwner, dstOwner, gold);
      }
    }
    return;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  dstPort(): TileRef {
    return this._dstPort.tile();
  }
}
