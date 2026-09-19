import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { GameImpl } from "../../src/core/game/GameImpl";
import { PlayerImpl } from "../../src/core/game/PlayerImpl";
import { setup } from "../util/Setup";
import { executeTicks } from "../util/utils";

const gameID = "transient_game";

// Cooldowns from Config; kept as literals so the test also pins the windows the
// prune is allowed to use.
const TARGET_COOLDOWN = 150;
const EMOJI_COOLDOWN = 50;
const ALLIANCE_REQUEST_COOLDOWN = 300;

interface BuiltGame {
  game: GameImpl;
  alpha: string;
  beta: string;
}

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
  return { game, alpha: alpha.id, beta: beta.id };
}

describe("PlayerImpl.pruneTransient", () => {
  test("drops targets and emojis once their windows have elapsed", async () => {
    const { game, alpha, beta } = await buildGame();
    const a = game.player(alpha) as PlayerImpl;
    const b = game.player(beta);

    a.target(b);
    a.sendEmoji(b, "hi");
    expect((a as any).targets_).toHaveLength(1);
    expect((a as any).outgoingEmojis_).toHaveLength(1);

    executeTicks(game, TARGET_COOLDOWN + 1);
    a.pruneTransient();

    expect((a as any).targets_).toHaveLength(0);
    expect((a as any).outgoingEmojis_).toHaveLength(0);
  });

  test("does not lift a target cooldown that is still in effect", async () => {
    const { game, alpha, beta } = await buildGame();
    const a = game.player(alpha) as PlayerImpl;
    const b = game.player(beta);

    a.target(b);

    // Past the display window (targetDuration = 100) but inside the cooldown
    // (targetCooldown = 150): canTarget must still say no, and pruning must not
    // discard the entry that says so.
    executeTicks(game, 101);
    expect(a.targets()).toEqual([]);
    expect(a.canTarget(b)).toBe(false);

    a.pruneTransient();
    expect((a as any).targets_).toHaveLength(1);
    expect(a.canTarget(b)).toBe(false);

    executeTicks(game, TARGET_COOLDOWN);
    a.pruneTransient();
    expect((a as any).targets_).toHaveLength(0);
    expect(a.canTarget(b)).toBe(true);
  });

  test("keeps a resolved alliance request inside its cooldown", async () => {
    const { game, alpha, beta } = await buildGame();
    const a = game.player(alpha) as PlayerImpl;
    const b = game.player(beta);

    const request = a.createAllianceRequest(b);
    expect(request).not.toBeNull();
    request!.reject();
    expect(a.canSendAllianceRequest(b)).toBe(false);

    executeTicks(game, EMOJI_COOLDOWN);
    a.pruneTransient();
    expect((a as any).pastOutgoingAllianceRequests).toHaveLength(1);
    expect(a.canSendAllianceRequest(b)).toBe(false);

    executeTicks(game, ALLIANCE_REQUEST_COOLDOWN);
    a.pruneTransient();
    expect((a as any).pastOutgoingAllianceRequests).toHaveLength(0);
    expect(a.canSendAllianceRequest(b)).toBe(true);
  });

  test("checkpoint capture is bounded by the prune windows", async () => {
    const { game, alpha, beta } = await buildGame();
    const a = game.player(alpha) as PlayerImpl;
    const b = game.player(beta);

    a.target(b);
    a.sendEmoji(b, "hi");

    executeTicks(game, TARGET_COOLDOWN + 1);
    // Bypass the per-tick prune: a checkpoint taken directly must still only
    // capture in-window history.
    const checkpoint = a.checkpoint();
    expect(checkpoint.targets).toHaveLength(0);
    expect(checkpoint.outgoingEmojis).toHaveLength(0);
  });
});
