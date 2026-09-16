import { PortExecution } from "../src/core/execution/PortExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let player: Player;
let other: Player;

describe("PortExecution", () => {
  beforeEach(async () => {
    game = await setup("half_land_half_ocean", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("other", PlayerType.Human, null, "other_id"),
    ]);

    player = game.player("player_id");
    player.addGold(BigInt(1000000));
    other = game.player("other_id");

    game.config().structureMinDist = () => 10;
  });

  test("Destination ports chances scale with level", () => {
    game.config().proximityBonusPortsNb = () => 0;
    game.config().tradeShipShortRangeDebuff = () => 0;

    player.conquer(game.ref(7, 10));
    const spawn = player.canBuild(UnitType.Port, game.ref(7, 10));
    if (spawn === false) {
      throw new Error("Unable to build port for test");
    }
    const port = player.buildUnit(UnitType.Port, spawn, {});
    const execution = new PortExecution(port);
    execution.init(game, 0);
    execution.tick(0);

    other.conquer(game.ref(0, 0));
    const otherPort = other.buildUnit(UnitType.Port, game.ref(0, 0), {});
    otherPort.increaseLevel();
    otherPort.increaseLevel();

    const ports = execution.tradingPorts();

    expect(ports.length).toBe(3);
  });

  test("Trade ship proximity bonus", () => {
    game.config().proximityBonusPortsNb = () => 10;
    game.config().tradeShipShortRangeDebuff = () => 0;

    player.conquer(game.ref(7, 10));
    const spawn = player.canBuild(UnitType.Port, game.ref(7, 10));
    if (spawn === false) {
      throw new Error("Unable to build port for test");
    }
    const port = player.buildUnit(UnitType.Port, spawn, {});
    const execution = new PortExecution(port);
    execution.init(game, 0);
    execution.tick(0);

    other.conquer(game.ref(0, 0));
    other.buildUnit(UnitType.Port, game.ref(0, 0), {});

    const ports = execution.tradingPorts();

    expect(ports.length).toBe(2);
  });

  test("Trade ship short range debuff", () => {
    game.config().proximityBonusPortsNb = () => 10;
    // Short range debuff cancels out the proximity bonus.
    game.config().tradeShipShortRangeDebuff = () => 100;

    player.conquer(game.ref(7, 10));
    const spawn = player.canBuild(UnitType.Port, game.ref(7, 10));
    if (spawn === false) {
      throw new Error("Unable to build port for test");
    }
    const port = player.buildUnit(UnitType.Port, spawn, {});
    const execution = new PortExecution(port);
    execution.init(game, 0);
    execution.tick(0);

    other.conquer(game.ref(0, 0));
    other.buildUnit(UnitType.Port, game.ref(0, 0), {});

    const ports = execution.tradingPorts();

    expect(ports.length).toBe(1);
  });

  test("same-nation ports are included at half weight", () => {
    game.config().proximityBonusPortsNb = () => 0;
    game.config().tradeShipShortRangeDebuff = () => 0;

    player.conquer(game.ref(7, 10));
    const spawn = player.canBuild(UnitType.Port, game.ref(7, 10));
    if (spawn === false) {
      throw new Error("Unable to build port for test");
    }
    const port = player.buildUnit(UnitType.Port, spawn, {});
    const execution = new PortExecution(port);
    execution.init(game, 0);

    const ownPort = {
      tile: () => spawn,
      level: () => 2,
      isActive: () => true,
      isMarkedForDeletion: () => false,
      isUnderConstruction: () => false,
    } as unknown as Unit;
    vi.spyOn(player, "units").mockReturnValue([port, ownPort]);

    expect(execution.ownNationPorts()).toEqual([ownPort, ownPort]);
  });

  test("same-nation port is half as likely to be picked as a foreign port", () => {
    player.conquer(game.ref(7, 10));
    const spawn = player.canBuild(UnitType.Port, game.ref(7, 10));
    if (spawn === false) {
      throw new Error("Unable to build port for test");
    }
    const port = player.buildUnit(UnitType.Port, spawn, {});
    const execution = new PortExecution(port);
    execution.init(game, 0);

    const foreignPort = { tile: () => game.ref(0, 0) } as unknown as Unit;
    const ownPort = { tile: () => game.ref(1, 0) } as unknown as Unit;
    const pick = (roll: number) => {
      execution["random"] = { nextInt: () => roll } as any;
      return execution["pickTradeDestination"]([foreignPort], [ownPort]);
    };

    // The foreign port occupies slots 0 and 1, the own port slot 2.
    expect(pick(0)).toBe(foreignPort);
    expect(pick(1)).toBe(foreignPort);
    expect(pick(2)).toBe(ownPort);

    execution["random"] = { nextInt: () => 0 } as any;
    expect(execution["pickTradeDestination"]([], [])).toBe(null);
  });

  test("shouldSpawnTradeShip recomputes spawn rate per level with updated rejection count", () => {
    player.conquer(game.ref(7, 10));
    const port = player.buildUnit(UnitType.Port, game.ref(7, 10), {});
    port.increaseLevel(); // level 2
    const execution = new PortExecution(port);
    execution.init(game, 0);

    const rejections: number[] = [];
    game.config().tradeShipSpawnRate = (r) => (rejections.push(r), 1000000);
    expect(execution.shouldSpawnTradeShip()).toBe(false);
    expect(rejections).toEqual([0, 1]);

    game.config().tradeShipSpawnRate = (r) => (rejections.push(r), 1);
    expect(execution.shouldSpawnTradeShip()).toBe(true);
    expect(rejections).toEqual([0, 1, 2]);

    game.config().tradeShipSpawnRate = (r) => (rejections.push(r), 1000000);
    expect(execution.shouldSpawnTradeShip()).toBe(false);
    expect(rejections).toEqual([0, 1, 2, 0, 1]);
  });
});
