import { ExecutionCheckpoint } from "../Checkpoint";
import { Execution, Game } from "../game/Game";
import { PlayerExecution } from "./PlayerExecution";
import { RecomputeRailClusterExecution } from "./RecomputeRailClusterExecution";
import { SpawnTimerExecution } from "./SpawnTimerExecution";
import { WinCheckExecution } from "./WinCheckExecution";

/**
 * B2: rebuild a single execution from its checkpoint.
 *
 * `initialize` mirrors the normal execution lifecycle: executions that had
 * already run are re-initialized (so their `init`-derived fields are set) before
 * the captured mutable state is applied; executions that were still pending
 * their first tick are reconstructed without running `init` and re-enter the
 * pending queue.
 *
 * Returns undefined for a kind that no longer exists in this build. The
 * checkpoint loader treats that as a hard failure and falls back to full
 * replay.
 */
export function restoreExecution(
  game: Game,
  cp: ExecutionCheckpoint,
  ticks: number,
  initialize: boolean,
): Execution | undefined {
  switch (cp.kind) {
    case "player": {
      const data = cp.data as {
        playerId: string;
        lastCalc: number;
        active: boolean;
      };
      if (!game.hasPlayer(data.playerId)) return undefined;
      const exec = new PlayerExecution(game.player(data.playerId));
      if (initialize) exec.init(game, ticks);
      exec.restoreCheckpoint(data);
      return exec;
    }
    case "wincheck": {
      const data = cp.data as {
        active: boolean;
        checkedRankedSpawns: boolean;
      };
      const exec = new WinCheckExecution();
      if (initialize) exec.init(game, ticks);
      exec.restoreCheckpoint(data);
      return exec;
    }
    case "spawntimer": {
      const exec = new SpawnTimerExecution();
      if (initialize) exec.init(game);
      exec.restoreCheckpoint({});
      return exec;
    }
    case "recompute_rail_cluster": {
      const exec = new RecomputeRailClusterExecution(game.railNetwork());
      if (initialize) exec.init(game, ticks);
      exec.restoreCheckpoint({});
      return exec;
    }
    default:
      return undefined;
  }
}
