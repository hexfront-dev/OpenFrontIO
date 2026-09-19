import { Executor } from "../../src/core/execution/ExecutionManager";
import { GameRunner } from "../../src/core/GameRunner";
import { setup } from "../util/Setup";

const gameID = "buffer_game";

// Mirrors GameRunner.TURN_BUFFER_TRIM_AT (private); kept as a literal so the
// test also pins the batching threshold.
const TRIM_AT = 1024;

describe("GameRunner turn buffer", () => {
  test("drops executed turns so only the backlog is retained", async () => {
    const game = await setup("plains", {}, [], undefined, undefined, false);
    const runner = new GameRunner(
      game,
      new Executor(game, gameID, undefined),
      () => {},
    );
    runner.init();

    const total = TRIM_AT * 2 + 500;
    for (let i = 0; i < total; i++) {
      runner.addTurn({ turnNumber: i, intents: [] });
    }
    expect(runner.pendingTurns()).toBe(total);

    let executed = 0;
    while (runner.executeNextTick()) {
      executed++;
    }
    expect(executed).toBe(total);

    // All turns ran, yet the buffer holds at most one trim batch of the
    // unexecuted queue (here: none) rather than the whole history.
    const internal = runner as unknown as {
      turns: unknown[];
      currTurn: number;
    };
    expect(runner.pendingTurns()).toBe(0);
    expect(internal.turns.length).toBeLessThan(TRIM_AT);
    expect(internal.currTurn).toBe(internal.turns.length);
  });
});
