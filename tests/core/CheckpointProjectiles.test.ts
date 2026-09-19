import { NukeExecution } from "../../src/core/execution/NukeExecution";
import { SAMLauncherExecution } from "../../src/core/execution/SAMLauncherExecution";
import { ShellExecution } from "../../src/core/execution/ShellExecution";
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

const gameID: GameID = "checkpoint_projectiles";

interface BuiltGame {
  game: GameImpl;
  alphaId: string;
  betaId: string;
}

/** Two spawned humans on the half-land/half-ocean map (deterministic). */
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

describe("B2 projectile checkpoints", () => {
  test("restores an in-flight nuke and replays its flight identically", async () => {
    const { game: original, alphaId, betaId } = await buildGame();
    const alpha = original.player(alphaId);
    const beta = original.player(betaId);

    alpha.conquer(original.ref(0, 1));
    alpha.conquer(original.ref(1, 1));
    constructionExecution(original, alpha, 0, 1, UnitType.MissileSilo);

    const target = original.ref(0, 15);
    expect(original.owner(target)).toBe(beta);
    original.addExecution(new NukeExecution(UnitType.AtomBomb, alpha, target));

    // First tick runs init, the next builds the missile, then a few in flight.
    executeTicks(original, 2);
    executeTicks(original, 2);
    expect(original.units(UnitType.AtomBomb)).toHaveLength(1);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const expectedHashes = drainHashes(original, 40);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);
    expect(restored.units(UnitType.AtomBomb)).toHaveLength(1);

    const actualHashes = drainHashes(restored, 40);
    expect(actualHashes).toEqual(expectedHashes);
  });

  test("restores an in-flight shell and replays its flight identically", async () => {
    const { game: original, alphaId, betaId } = await buildGame();
    const alpha = original.player(alphaId);
    const beta = original.player(betaId);

    const shooter = alpha.buildUnit(UnitType.Warship, original.ref(8, 2), {
      patrolTile: original.ref(8, 2),
    });
    const target = beta.buildUnit(UnitType.Warship, original.ref(8, 13), {
      patrolTile: original.ref(8, 13),
    });
    original.addExecution(
      new ShellExecution(original.ref(8, 2), alpha, shooter, target),
    );

    executeTicks(original, 3);
    expect(original.units(UnitType.Shell)).toHaveLength(1);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const expectedHashes = drainHashes(original, 40);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);
    expect(restored.units(UnitType.Shell)).toHaveLength(1);

    const actualHashes = drainHashes(restored, 40);
    expect(actualHashes).toEqual(expectedHashes);
  });

  test("restores a live SAM launcher and replays its scan identically", async () => {
    const { game: original, alphaId } = await buildGame();
    const alpha = original.player(alphaId);

    alpha.conquer(original.ref(0, 2));
    const sam = alpha.buildUnit(UnitType.SAMLauncher, original.ref(0, 2), {});
    original.addExecution(
      new SAMLauncherExecution(alpha, original.ref(0, 2), sam),
    );

    executeTicks(original, 3);
    expect(original.units(UnitType.SAMLauncher)).toHaveLength(1);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const expectedHashes = drainHashes(original, 40);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored } = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);
    expect(restored.units(UnitType.SAMLauncher)).toHaveLength(1);

    const actualHashes = drainHashes(restored, 40);
    expect(actualHashes).toEqual(expectedHashes);
  });
});
