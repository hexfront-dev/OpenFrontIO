import { renderNumber } from "../../client/Utils";
import { ExecutionCheckpoint } from "../Checkpoint";
import {
  Execution,
  Game,
  Gold,
  MessageType,
  Player,
  PlayerID,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import {
  WaterPathFinder,
  WaterPathFinderSnapshot,
} from "../pathfinding/PathFinder";
import { tradeShipStagger } from "../pathfinding/PathfinderStagger";
import { PathStatus } from "../pathfinding/types";
import { findClosestBy } from "../Util";

export interface TradeShipExecutionCheckpoint {
  origOwnerId: PlayerID;
  srcPortId: number;
  /** Current destination port id (can change after a capture). */
  dstPortId: number;
  tradeShipId: number | null;
  wasCaptured: boolean;
  tilesTraveled: number;
  motionPlanId: number;
  motionPlanDst: TileRef | null;
  active: boolean;
  /** null for an execution captured before its first tick. */
  pathFinder: WaterPathFinderSnapshot | null;
}

export class TradeShipExecution implements Execution {
  private active = true;
  private mg: Game;
  private tradeShip: Unit | undefined;
  private wasCaptured = false;
  private pathFinder: WaterPathFinder;
  private tilesTraveled = 0;
  private motionPlanId = 1;
  private motionPlanDst: TileRef | null = null;
  private initialized = false;

  constructor(
    private origOwner: Player,
    private srcPort: Unit,
    private _dstPort: Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    const stagger = tradeShipStagger.next();
    this.pathFinder = new WaterPathFinder(mg, stagger, true); // memoized: port tile to port tile repeats
    this.initialized = true;
  }

  /** B2: capture the voyage (route cache, tolls-travelled, current target). */
  checkpoint(): ExecutionCheckpoint {
    return {
      kind: "trade_ship",
      data: {
        origOwnerId: this.origOwner.id(),
        srcPortId: this.srcPort.id(),
        dstPortId: this._dstPort.id(),
        tradeShipId: this.tradeShip?.id() ?? null,
        wasCaptured: this.wasCaptured,
        tilesTraveled: this.tilesTraveled,
        motionPlanId: this.motionPlanId,
        motionPlanDst: this.motionPlanDst,
        active: this.active,
        pathFinder: this.initialized ? this.pathFinder.snapshot() : null,
      } satisfies TradeShipExecutionCheckpoint,
    };
  }

  /**
   * B2: overwrite this execution from a checkpoint. The source/destination
   * ports are resolved by the loader and passed to the constructor, so this
   * only installs the mutable voyage state. Returns false when the ship exists
   * but cannot be resolved (fail-safe).
   */
  restoreCheckpoint(game: Game, data: TradeShipExecutionCheckpoint): boolean {
    this.mg = game;
    this.active = data.active;
    this.wasCaptured = data.wasCaptured;
    this.tilesTraveled = data.tilesTraveled;
    this.motionPlanId = data.motionPlanId;
    this.motionPlanDst = data.motionPlanDst;
    if (data.tradeShipId === null) {
      this.tradeShip = undefined;
    } else {
      const ship = game.unit(data.tradeShipId);
      if (ship === undefined) return false;
      this.tradeShip = ship;
    }
    if (data.pathFinder !== null) {
      this.pathFinder = new WaterPathFinder(
        game,
        data.pathFinder.stagger,
        data.pathFinder.memoized,
      );
      this.pathFinder.restore(data.pathFinder);
      this.initialized = true;
    }
    return true;
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
   * Toll the ship the instant it enters a Tollhouse's range: the toller is paid
   * immediately a percentage of the value the ship will have at its destination.
   * Only one toll per tolling nation is recorded, and each Tollhouse spends one
   * unit of its per-window capacity. The gold paid here is subtracted from the
   * trade's payout when the ship arrives.
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
      // Don't tax a ship that is trading with the toller: a ship bound for one
      // of the toller's own ports passes free.
      if (this._dstPort.owner() === tollOwner) continue;
      const range = this.mg.config().tollhouseRange(unit.level());
      if (distSquared > range * range) continue;
      const percent = tollOwner.tollRateFor(owner);
      if (percent <= 0) continue;
      if (ship.hasTollFrom(tollOwner.smallID())) continue;
      if (!unit.canTollShip(ticks)) continue;

      // A ship's worth grows with the distance it has travelled, so project the
      // value it will have when it reaches its destination and tax that. Pay the
      // toller now and remember the amount so the trade endpoints are not taxed
      // twice.
      const value = this.projectedArrivalValue(curTile);
      const taken = (value * BigInt(percent)) / 100n;
      ship.addToll(tollOwner.smallID(), percent, unit.tile(), taken);
      unit.recordToll(ticks);
      if (taken <= 0n) continue;
      tollOwner.addGold(taken, unit.tile());
      // Notify the toller that they collected from a passing trade ship.
      this.mg.displayMessage(
        "events_display.toll_earned",
        MessageType.TOLL,
        tollOwner.id(),
        taken,
        { gold: renderNumber(taken) },
        undefined,
        tollOwner.id(),
      );
    }
  }

  /**
   * The ship's gold value once it reaches its destination. Its value is a
   * function of total distance travelled, so a one-shot path query gives the
   * remaining route length, which is added to the distance covered so far.
   */
  private projectedArrivalValue(curTile: TileRef): Gold {
    const dst = this._dstPort.tile();
    const remaining = this.pathFinder.findPath(curTile, dst);
    const remainingMoves =
      remaining === null ? 0 : Math.max(0, remaining.length - 1);
    return this.mg
      .config()
      .tradeShipGold(
        this.tilesTraveled + remainingMoves,
        this.tradeShip!.owner(),
      );
  }

  /**
   * Tolls are paid the moment a ship is tolled, so on arrival we only remove
   * the already-paid amounts from the value the trade endpoints split.
   */
  private deductTolls(gross: Gold): Gold {
    let remaining = gross;
    for (const toll of this.tradeShip!.tolls()) {
      remaining -= toll.gold;
      if (remaining <= 0n) return 0n;
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
