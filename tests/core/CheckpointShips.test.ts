import { MissileDefenseShipExecution } from "../../src/core/execution/MissileDefenseShipExecution";
import { MissileShipExecution } from "../../src/core/execution/MissileShipExecution";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { TradeShipExecution } from "../../src/core/execution/TradeShipExecution";
import { TransportShipExecution } from "../../src/core/execution/TransportShipExecution";
import { WarshipExecution } from "../../src/core/execution/WarshipExecution";
import { WinCheckExecution } from "../../src/core/execution/WinCheckExecution";
import {
  Game,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { GameImpl } from "../../src/core/game/GameImpl";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import { GameID } from "../../src/core/Schemas";
import { setup } from "../util/Setup";
import { executeTicks } from "../util/utils";

const gameID: GameID = "checkpoint_ships";

interface BuiltGame {
  game: GameImpl;
  alphaId: string;
  betaId: string;
}

/**
 * Two spawned human players on the half-land/half-ocean map. Spawning creates
 * the long-lived PlayerExecution; WinCheck is added like GameRunner.init. The
 * map is fully deterministic so the same builder always produces the same game.
 */
async function buildGame(): Promise<BuiltGame> {
  const game = (await setup("half_land_half_ocean", {
    infiniteGold: true,
    instantBuild: true,
    infiniteTroops: true,
  })) as GameImpl;

  const alpha = new PlayerInfo(
    "alpha",
    PlayerType.Human,
    "client_alpha",
    "alpha_id",
  );
  const beta = new PlayerInfo(
    "beta",
    PlayerType.Human,
    "client_beta",
    "beta_id",
  );
  game.addPlayer(alpha);
  game.addPlayer(beta);

  game.addExecution(
    new SpawnExecution(gameID, game.player(alpha.id).info(), game.ref(0, 0)),
    new SpawnExecution(gameID, game.player(beta.id).info(), game.ref(0, 15)),
  );
  executeTicks(game, 2);
  game.addExecution(new WinCheckExecution());

  return { game, alphaId: alpha.id, betaId: beta.id };
}

function drainHashes(game: Game, ticks: number): number[] {
  const hashes: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const updates = game.executeNextTick();
    for (const update of updates[GameUpdateType.Hash]) {
      hashes.push(update.hash);
    }
  }
  return hashes;
}

describe("B2 ship checkpoints", () => {
  test("restores a live trade ship and replays its voyage identically", async () => {
    const { game: original, alphaId, betaId } = await buildGame();
    const alpha = original.player(alphaId);
    const beta = original.player(betaId);

    // Own the coast so the ports are not repossessed by PlayerExecution.
    alpha.conquer(original.ref(7, 2));
    alpha.conquer(original.ref(7, 3));
    beta.conquer(original.ref(7, 12));
    beta.conquer(original.ref(7, 13));

    const srcPort = alpha.buildUnit(UnitType.Port, original.ref(7, 2), {});
    const dstPort = beta.buildUnit(UnitType.Port, original.ref(7, 13), {});
    original.addExecution(new TradeShipExecution(alpha, srcPort, dstPort));

    // Run until the ship is established and mid-route with a cached path.
    executeTicks(original, 6);
    expect(original.units(UnitType.TradeShip)).toHaveLength(1);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const expectedHashes = drainHashes(original, 40);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored, alphaId: ra, betaId: rb } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);
    expect(restored.units(UnitType.TradeShip)).toHaveLength(1);
    expect(restored.player(ra).units(UnitType.Port)).toHaveLength(1);
    expect(restored.player(rb).units(UnitType.Port)).toHaveLength(1);

    const actualHashes = drainHashes(restored, 40);
    expect(actualHashes).toEqual(expectedHashes);
  });

  test("restores a live transport ship and replays its voyage identically", async () => {
    const { game: original, betaId } = await buildGame();
    const beta = original.player(betaId);

    // Give the invader a coastal foothold so a water route exists.
    beta.conquer(original.ref(7, 1));
    beta.conquer(original.ref(6, 1));
    beta.conquer(original.ref(7, 2));

    const enemyShore = original.ref(7, 13);
    original.addExecution(new TransportShipExecution(beta, enemyShore, 100));

    executeTicks(original, 4);
    expect(original.units(UnitType.TransportShip)).toHaveLength(1);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const expectedHashes = drainHashes(original, 40);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);
    expect(restored.units(UnitType.TransportShip)).toHaveLength(1);

    const actualHashes = drainHashes(restored, 40);
    expect(actualHashes).toEqual(expectedHashes);
  });

  /** A player with a coastal port, ready for its warship family to spawn. */
  async function buildPortGame() {
    const built = await buildGame();
    const alpha = built.game.player(built.alphaId);
    alpha.conquer(built.game.ref(7, 2));
    alpha.conquer(built.game.ref(7, 3));
    alpha.buildUnit(UnitType.Port, built.game.ref(7, 2), {});
    return { ...built, alpha };
  }

  test("restores a live warship and replays its patrol identically", async () => {
    const { game: original, alphaId } = await buildPortGame();
    const alpha = original.player(alphaId);

    original.addExecution(
      new WarshipExecution({ owner: alpha, patrolTile: original.ref(8, 2) }),
    );
    executeTicks(original, 8);
    expect(original.units(UnitType.Warship)).toHaveLength(1);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const expectedHashes = drainHashes(original, 40);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored, alphaId: ra } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);
    expect(restored.units(UnitType.Warship)).toHaveLength(1);
    expect(restored.player(ra).units(UnitType.Port)).toHaveLength(1);

    const actualHashes = drainHashes(restored, 40);
    expect(actualHashes).toEqual(expectedHashes);
  });

  test("restores a live missile ship and replays its patrol identically", async () => {
    const { game: original, alphaId } = await buildPortGame();
    const alpha = original.player(alphaId);

    original.addExecution(
      new MissileShipExecution({
        owner: alpha,
        patrolTile: original.ref(8, 2),
      }),
    );
    executeTicks(original, 8);
    expect(original.units(UnitType.MissileShip)).toHaveLength(1);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const expectedHashes = drainHashes(original, 40);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);
    expect(restored.units(UnitType.MissileShip)).toHaveLength(1);

    const actualHashes = drainHashes(restored, 40);
    expect(actualHashes).toEqual(expectedHashes);
  });

  test("restores a live missile defense ship and replays its patrol identically", async () => {
    const { game: original, alphaId } = await buildPortGame();
    const alpha = original.player(alphaId);

    original.addExecution(
      new MissileDefenseShipExecution({
        owner: alpha,
        patrolTile: original.ref(8, 2),
      }),
    );
    executeTicks(original, 8);
    expect(original.units(UnitType.MissileDefenseShip)).toHaveLength(1);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const expectedHashes = drainHashes(original, 40);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);
    expect(restored.units(UnitType.MissileDefenseShip)).toHaveLength(1);

    const actualHashes = drainHashes(restored, 40);
    expect(actualHashes).toEqual(expectedHashes);
  });
});
