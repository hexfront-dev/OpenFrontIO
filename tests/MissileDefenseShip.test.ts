import { MissileDefenseShipExecution } from "../src/core/execution/MissileDefenseShipExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

const coastX = 7;
let game: Game;
let defender: Player;
let attacker: Player;

describe("MissileDefenseShip", () => {
  beforeEach(async () => {
    game = await setup(
      "half_land_half_ocean",
      { infiniteGold: true, instantBuild: true },
      [
        new PlayerInfo("defender", PlayerType.Human, null, "defender_id"),
        new PlayerInfo("attacker", PlayerType.Human, null, "attacker_id"),
      ],
    );
    defender = game.player("defender_id");
    attacker = game.player("attacker_id");
  });

  test("SAM ship intercepts an incoming nuke", () => {
    const ship = defender.buildUnit(
      UnitType.MissileDefenseShip,
      game.ref(coastX + 1, 10),
      { patrolTile: game.ref(coastX + 1, 10) },
    );
    game.addExecution(new MissileDefenseShipExecution(ship));

    attacker.buildUnit(UnitType.AtomBomb, game.ref(coastX + 1, 10), {
      targetTile: game.ref(coastX + 1, 12),
      trajectory: [
        { tile: game.ref(coastX + 1, 10), targetable: true },
        { tile: game.ref(coastX + 1, 11), targetable: true },
        { tile: game.ref(coastX + 1, 12), targetable: true },
      ],
    });

    executeTicks(game, 5);

    expect(attacker.units(UnitType.AtomBomb)).toHaveLength(0);
  });

  test("Fleeted SAM ship still intercepts an incoming nuke", () => {
    const ship = defender.buildUnit(
      UnitType.MissileDefenseShip,
      game.ref(coastX + 1, 10),
      { patrolTile: game.ref(coastX + 1, 10) },
    );
    ship.setFleetId(1);
    game.addExecution(new MissileDefenseShipExecution(ship));

    attacker.buildUnit(UnitType.AtomBomb, game.ref(coastX + 1, 10), {
      targetTile: game.ref(coastX + 1, 12),
      trajectory: [
        { tile: game.ref(coastX + 1, 10), targetable: true },
        { tile: game.ref(coastX + 1, 11), targetable: true },
        { tile: game.ref(coastX + 1, 12), targetable: true },
      ],
    });

    executeTicks(game, 5);

    expect(attacker.units(UnitType.AtomBomb)).toHaveLength(0);
  });
});
