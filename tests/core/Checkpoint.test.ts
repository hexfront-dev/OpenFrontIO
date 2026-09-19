import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
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
import { constructionExecution, executeTicks } from "../util/utils";

const gameID: GameID = "checkpoint_game";

interface BuiltGame {
  game: GameImpl;
  alpha: string;
  beta: string;
}

/**
 * Two spawned human players on a small land/ocean map. Spawning creates the
 * long-lived PlayerExecution for each; WinCheck is added like GameRunner.init.
 * No units and no intents, so every active execution supports checkpoints.
 */
async function buildGame(): Promise<BuiltGame> {
  const game = (await setup("ocean_and_land", {
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
    new SpawnExecution(gameID, game.player(alpha.id).info(), game.ref(0, 15)),
    new SpawnExecution(gameID, game.player(beta.id).info(), game.ref(0, 10)),
  );
  executeTicks(game, 2);
  game.addExecution(new WinCheckExecution());

  return { game, alpha: alpha.id, beta: beta.id };
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

describe("B2 core checkpoints", () => {
  test("restored game replays the suffix identically", async () => {
    const { game: original } = await buildGame();
    // Advance well past the spawn phase so every execution is established.
    executeTicks(original, 78);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    // Continue the original for a while and record the periodic state hashes.
    const expectedHashes = drainHashes(original, 45);
    expect(expectedHashes.length).toBeGreaterThan(0);

    // Build a second, identical game and restore the checkpoint into it.
    const { game: restored } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);

    const actualHashes = drainHashes(restored, 45);
    expect(actualHashes).toEqual(expectedHashes);

    // Sanity check a couple of authoritative values round-trip too.
    expect(restored.ticks()).toBe(original.ticks());
    expect(restored.players().length).toBe(original.players().length);
  });

  test("checkpoint captures and restores player state", async () => {
    const { game: original, alpha } = await buildGame();
    executeTicks(original, 40);

    const before = original.player(alpha);
    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const { game: restored } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);

    const after = restored.player(alpha);
    expect(after.gold()).toBe(before.gold());
    expect(after.troops()).toBe(before.troops());
    expect(after.numTilesOwned()).toBe(before.numTilesOwned());
    expect(after.hasSpawned()).toBe(true);
  });

  test("restores a live structure execution", async () => {
    const { game: original, alpha } = await buildGame();
    const owner = original.player(alpha);

    constructionExecution(original, owner, 0, 15, UnitType.MissileSilo);
    expect(owner.units(UnitType.MissileSilo)).toHaveLength(1);
    executeTicks(original, 25);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const expectedHashes = drainHashes(original, 35);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);
    expect(restored.player(alpha).units(UnitType.MissileSilo)).toHaveLength(1);

    const actualHashes = drainHashes(restored, 35);
    expect(actualHashes).toEqual(expectedHashes);
  });

  test("refuses to checkpoint when an active execution cannot serialize", async () => {
    const { game } = await buildGame();
    // A bare object that implements Execution but not checkpoint().
    game.addExecution({
      isActive: () => true,
      activeDuringSpawnPhase: () => false,
      init: () => {},
      tick: () => {},
    });

    expect(game.checkpoint()).toBeUndefined();
  });
});
