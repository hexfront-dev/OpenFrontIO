import { AttackExecution } from "../src/core/execution/AttackExecution";
import { AvoidConquestExecution } from "../src/core/execution/AvoidConquestExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import {
  Attack,
  Game,
  Player,
  PlayerInfo,
  PlayerType,
} from "../src/core/game/Game";
import { TileRef } from "../src/core/game/GameMap";
import { GameID } from "../src/core/Schemas";
import { setup } from "./util/Setup";

const gameID: GameID = "game_id";

describe("AvoidConquestExecution", () => {
  let game: Game;
  let attacker: Player;

  beforeEach(async () => {
    game = await setup("ocean_and_land", { infiniteTroops: true });
    const info = new PlayerInfo(
      "attacker",
      PlayerType.Human,
      null,
      "attacker_id",
    );
    game.addPlayer(info);
    game.addExecution(new SpawnExecution(gameID, info, game.ref(0, 10)));
    game.executeNextTick();
    game.executeNextTick();
    attacker = game.player(info.id);
  });

  function startAttack(): Attack {
    game.addExecution(
      new AttackExecution(1000, attacker, game.terraNullius().id()),
    );
    game.executeNextTick();
    return attacker.outgoingAttacks()[0];
  }

  // Apply an avoid intent. Executions init on their first tick and run their
  // tick on the second, so this advances the game by two ticks.
  function applyAvoid(attackID: string, tiles: TileRef[]): void {
    game.addExecution(new AvoidConquestExecution(attacker, attackID, tiles));
    game.executeNextTick();
    game.executeNextTick();
  }

  // Tiles owned by the target (terra nullius) that are 4-adjacent to the
  // attacker's territory.
  function frontierTiles(): TileRef[] {
    const myID = attacker.smallID();
    const result = new Set<TileRef>();
    const nbuf: TileRef[] = [0, 0, 0, 0];
    attacker.tiles().forEach((tile) => {
      const n = game.neighbors4(tile, nbuf);
      for (let i = 0; i < n; i++) {
        const nb = nbuf[i];
        if (game.ownerID(nb) === myID) continue;
        if (game.isWater(nb) || game.isImpassable(nb)) continue;
        result.add(nb);
      }
    });
    return [...result];
  }

  test("toggles tiles in the attack avoidance set", () => {
    const attack = startAttack();
    const frontier = frontierTiles();
    expect(frontier.length).toBeGreaterThan(0);
    const a = frontier[0];
    const b = frontier[1] ?? frontier[0];

    applyAvoid(attack.id(), [a, b]);

    expect(attack.isAvoided(a)).toBe(true);
    expect(attack.isAvoided(b)).toBe(true);
    expect(attack.avoidedTiles()).toHaveLength(a === b ? 1 : 2);

    // Re-toggling the same tile removes the avoidance.
    applyAvoid(attack.id(), [a]);

    expect(attack.isAvoided(a)).toBe(false);
    expect(attack.isAvoided(b)).toBe(true);
  });

  test("is a no-op for an unknown attack id", () => {
    const attack = startAttack();
    const frontier = frontierTiles();

    applyAvoid("does-not-exist", frontier);

    expect(attack.avoidedTiles()).toHaveLength(0);
  });

  test("an avoided frontier tile is never conquered", () => {
    const attack = startAttack();
    const frontier = frontierTiles();
    expect(frontier.length).toBeGreaterThan(1);
    const avoided = frontier[0];

    applyAvoid(attack.id(), [avoided]);

    // Let the attack run until it retreats on its own.
    for (let i = 0; i < 200 && attacker.outgoingAttacks().length > 0; i++) {
      game.executeNextTick();
    }

    // The avoided tile stays terra nullius even though everything around it
    // was conquered.
    expect(game.ownerID(avoided)).toBe(game.terraNullius().smallID());
    expect(attacker.outgoingAttacks()).toHaveLength(0);
  });
});
