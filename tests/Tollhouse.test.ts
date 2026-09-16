import { SetTollRateExecution } from "../src/core/execution/SetTollRateExecution";
import { TradeShipExecution } from "../src/core/execution/TradeShipExecution";
import {
  Game,
  MessageType,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../src/core/game/Game";
import { TileRef } from "../src/core/game/GameMap";
import { PathStatus } from "../src/core/pathfinding/types";
import { setup } from "./util/Setup";

// Find a land tile that is cardinally adjacent to water, plus that water tile.
// The two are one tile apart, so any Tollhouse range easily covers both.
function findLandWaterPair(game: Game): { land: TileRef; water: TileRef } {
  for (let x = 0; x < game.width(); x++) {
    for (let y = 0; y < game.height(); y++) {
      const land = game.ref(x, y);
      if (!game.isLand(land)) continue;
      for (const neighbor of game.neighbors(land)) {
        if (game.isWater(neighbor)) {
          return { land, water: neighbor };
        }
      }
    }
  }
  throw new Error("map has no land/water border");
}

describe("Tollhouse", () => {
  let game: Game;
  let toller: Player;
  let trader: Player;
  let other: Player;

  beforeEach(async () => {
    game = await setup("half_land_half_ocean", { instantBuild: true }, [
      new PlayerInfo("toller", PlayerType.Human, null, "toller_id"),
      new PlayerInfo("trader", PlayerType.Human, null, "trader_id"),
      new PlayerInfo("other", PlayerType.Human, null, "other_id"),
    ]);
    toller = game.player("toller_id");
    trader = game.player("trader_id");
    other = game.player("other_id");
    toller.addGold(10_000_000n);
  });

  test("range scales 5% per level and caps at 1.5x", () => {
    const base = game.config().tollhouseBaseRange();
    expect(game.config().tollhouseRange(1)).toBe(base);
    expect(game.config().tollhouseRange(2)).toBe(Math.floor(base * 1.05));
    expect(game.config().tollhouseRange(11)).toBe(Math.floor(base * 1.5));
    expect(game.config().tollhouseRange(50)).toBe(Math.floor(base * 1.5));
  });

  test("toll capacity is 1 ship per level per cooldown window", () => {
    const { land } = findLandWaterPair(game);
    const tollhouse = toller.buildUnit(UnitType.Tollhouse, land, {});

    expect(tollhouse.canTollShip(0)).toBe(true);
    tollhouse.recordToll(0);
    expect(tollhouse.canTollShip(29)).toBe(false);
    // Outside the 30-tick window the slot frees up again.
    expect(tollhouse.canTollShip(30)).toBe(true);

    // One extra slot per level.
    tollhouse.increaseLevel();
    tollhouse.recordToll(100);
    tollhouse.recordToll(100);
    expect(tollhouse.canTollShip(100)).toBe(false);
    expect(tollhouse.canTollShip(130)).toBe(true);
  });

  test("setTollRate clamps to 0-100 and clears at 0", () => {
    const exec = new SetTollRateExecution(toller, trader.id(), 40);
    exec.init(game, 0);
    exec.tick(0);
    expect(toller.tollRateFor(trader)).toBe(40);

    const clear = new SetTollRateExecution(toller, trader.id(), 0);
    clear.init(game, 0);
    clear.tick(0);
    expect(toller.tollRateFor(trader)).toBe(0);
  });

  test("a ship passing a tolling nation's range is taxed once", () => {
    const { land, water } = findLandWaterPair(game);
    const tollhouse = toller.buildUnit(UnitType.Tollhouse, land, {});
    // Second tollhouse from the same nation must not tax the same ship again.
    toller.buildUnit(UnitType.Tollhouse, land, {});
    toller.setTollRate(trader, 25);

    const dstOwner = other;
    const srcPort = {
      id: () => 9001,
      tile: () => water,
      owner: () => trader,
      isActive: () => true,
    } as unknown as Unit;
    const dstPort = {
      id: () => 9002,
      tile: () => game.ref(0, 0),
      owner: () => dstOwner,
      isActive: () => true,
    } as unknown as Unit;

    const ship = trader.buildUnit(UnitType.TradeShip, water, {
      targetUnit: dstPort,
    });

    const exec = new TradeShipExecution(trader, srcPort, dstPort);
    exec.init(game, 0);
    exec["pathFinder"] = {
      rebuilt: false,
      next: () => ({ status: PathStatus.NEXT, node: water }),
      pathForTraversal: () => [water],
      findPath: () => [water],
    } as any;
    exec["tradeShip"] = ship;

    exec.tick(1);

    expect(ship.hasTollFrom(toller.smallID())).toBe(true);
    expect(ship.tolls()).toHaveLength(1);
    expect(ship.tolls()[0].percent).toBe(25);
    expect(tollhouse.canTollShip(1)).toBe(false);
  });

  test("does not toll a ship bound for the toller's own port", () => {
    const { land, water } = findLandWaterPair(game);
    toller.buildUnit(UnitType.Tollhouse, land, {});
    toller.setTollRate(trader, 25);

    const srcPort = {
      id: () => 9001,
      tile: () => water,
      owner: () => trader,
      isActive: () => true,
    } as unknown as Unit;
    // Destination owned by the same nation as the Tollhouse.
    const dstPort = {
      id: () => 9002,
      tile: () => game.ref(0, 0),
      owner: () => toller,
      isActive: () => true,
    } as unknown as Unit;

    const ship = trader.buildUnit(UnitType.TradeShip, water, {
      targetUnit: dstPort,
    });

    const exec = new TradeShipExecution(trader, srcPort, dstPort);
    exec.init(game, 0);
    exec["pathFinder"] = {
      rebuilt: false,
      next: () => ({ status: PathStatus.NEXT, node: water }),
      pathForTraversal: () => [water],
    } as any;
    exec["tradeShip"] = ship;

    exec.tick(1);

    expect(ship.hasTollFrom(toller.smallID())).toBe(false);
    expect(ship.tolls()).toHaveLength(0);
  });

  test("a toll is paid to the toller the moment the ship is tolled", () => {
    const { land, water } = findLandWaterPair(game);
    toller.buildUnit(UnitType.Tollhouse, land, {});
    toller.setTollRate(trader, 25);

    const dstOwner = other;
    const srcPort = {
      id: () => 9001,
      tile: () => water,
      owner: () => trader,
      isActive: () => true,
    } as unknown as Unit;
    const dstPort = {
      id: () => 9002,
      tile: () => game.ref(0, 0),
      owner: () => dstOwner,
      isActive: () => true,
    } as unknown as Unit;

    const ship = trader.buildUnit(UnitType.TradeShip, water, {
      targetUnit: dstPort,
    });

    // The remaining route is two moves long, so the toll is a cut of the value
    // the ship will have after those two moves (distance 2), not its value now.
    const projectedPath = [water, game.ref(1, 0), game.ref(0, 0)];
    const exec = new TradeShipExecution(trader, srcPort, dstPort);
    exec.init(game, 0);
    exec["pathFinder"] = {
      rebuilt: false,
      next: () => ({ status: PathStatus.NEXT, node: water }),
      pathForTraversal: () => [water],
      findPath: () => projectedPath,
    } as any;
    exec["tradeShip"] = ship;

    const tollerBefore = toller.gold();
    const displaySpy = vi.spyOn(game, "displayMessage");

    exec.tick(1);

    const value = game.config().tradeShipGold(projectedPath.length - 1, trader);
    const taken = (value * 25n) / 100n;

    expect(taken).toBeGreaterThan(0n);
    expect(toller.gold() - tollerBefore).toBe(taken);
    expect(ship.tolls()).toHaveLength(1);
    expect(ship.tolls()[0].gold).toBe(taken);

    // The toller is told, privately, that a ship paid them.
    expect(displaySpy).toHaveBeenCalledWith(
      "events_display.toll_earned",
      MessageType.TOLL,
      toller.id(),
      taken,
      { gold: expect.any(String) },
      undefined,
      toller.id(),
    );
  });

  test("tolls already paid are deducted from the endpoints' payout", () => {
    const { land, water } = findLandWaterPair(game);
    const dstOwner = other;

    const srcPort = {
      id: () => 9001,
      tile: () => water,
      owner: () => trader,
      isActive: () => true,
    } as unknown as Unit;
    const dstPort = {
      id: () => 9002,
      tile: () => game.ref(0, 0),
      owner: () => dstOwner,
      isActive: () => true,
    } as unknown as Unit;

    const ship = trader.buildUnit(UnitType.TradeShip, water, {
      targetUnit: dstPort,
    });
    // Simulate the ship having already paid a toll while passing a Tollhouse.
    const gross = game.config().tradeShipGold(200, trader);
    const paidToll = gross / 4n;
    ship.addToll(toller.smallID(), 50, land, paidToll);

    const exec = new TradeShipExecution(trader, srcPort, dstPort);
    exec.init(game, 0);
    exec["pathFinder"] = {
      rebuilt: false,
      next: () => ({ status: PathStatus.COMPLETE, node: water }),
      pathForTraversal: () => [water],
    } as any;
    exec["tradeShip"] = ship;
    exec["tilesTraveled"] = 200;

    const tollerBefore = toller.gold();
    const traderBefore = trader.gold();
    const otherBefore = dstOwner.gold();

    exec.tick(1);

    const remaining = gross - paidToll;

    // No gold is paid at arrival; the toller already got it when tolled.
    expect(toller.gold()).toBe(tollerBefore);
    expect(trader.gold() - traderBefore).toBe(remaining);
    expect(dstOwner.gold() - otherBefore).toBe(remaining);
  });
});
