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

  // Apply an avoid intent. AvoidConquestExecution toggles the player's
  // persistent set in init(), which runs on the next tick.
  function applyAvoid(tiles: TileRef[]): void {
    game.addExecution(new AvoidConquestExecution(attacker, tiles));
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

  // Let any ongoing attacks run until the player has none left (they retreat).
  function runAttacksToCompletion(): void {
    for (let i = 0; i < 200 && attacker.outgoingAttacks().length > 0; i++) {
      game.executeNextTick();
    }
  }

  test("toggles tiles in the player's avoidance set", () => {
    const frontier = frontierTiles();
    expect(frontier.length).toBeGreaterThan(0);
    const a = frontier[0];
    const b = frontier[1] ?? frontier[0];

    applyAvoid([a, b]);

    expect(attacker.isAvoidedTile(a)).toBe(true);
    expect(attacker.isAvoidedTile(b)).toBe(true);
    expect(attacker.avoidedTiles()).toHaveLength(a === b ? 1 : 2);

    // Re-toggling the same tile removes the avoidance.
    applyAvoid([a]);

    expect(attacker.isAvoidedTile(a)).toBe(false);
    expect(attacker.isAvoidedTile(b)).toBe(true);
  });

  test("an avoided frontier tile is never conquered", () => {
    const frontier = frontierTiles();
    expect(frontier.length).toBeGreaterThan(1);
    const avoided = frontier[0];

    applyAvoid([avoided]);
    startAttack();
    runAttacksToCompletion();

    // The avoided tile stays terra nullius even though everything around it
    // was conquered.
    expect(game.ownerID(avoided)).toBe(game.terraNullius().smallID());
    expect(attacker.outgoingAttacks()).toHaveLength(0);
  });

  test("avoidance persists across attacks until toggled off", () => {
    const frontier = frontierTiles();
    expect(frontier.length).toBeGreaterThan(1);
    const avoided = frontier[0];

    applyAvoid([avoided]);

    // First attack completes without conquering the avoided tile.
    startAttack();
    runAttacksToCompletion();
    expect(game.ownerID(avoided)).toBe(game.terraNullius().smallID());
    expect(attacker.isAvoidedTile(avoided)).toBe(true);

    // A later attack still respects the same persistent exclusion.
    startAttack();
    runAttacksToCompletion();
    expect(game.ownerID(avoided)).toBe(game.terraNullius().smallID());
    expect(attacker.isAvoidedTile(avoided)).toBe(true);

    // Toggling it off re-enables conquest for future attacks.
    applyAvoid([avoided]);
    expect(attacker.isAvoidedTile(avoided)).toBe(false);

    startAttack();
    runAttacksToCompletion();
    expect(game.ownerID(avoided)).toBe(attacker.smallID());
  });
});
