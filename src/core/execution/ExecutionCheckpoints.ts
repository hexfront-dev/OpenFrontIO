import { ExecutionCheckpoint } from "../Checkpoint";
import { Execution, Game, UnitType } from "../game/Game";
import { PseudoRandomState } from "../PseudoRandom";
import { CityExecution } from "./CityExecution";
import { ConstructionExecution } from "./ConstructionExecution";
import { DefensePostExecution } from "./DefensePostExecution";
import { FactoryExecution } from "./FactoryExecution";
import { MissileSiloExecution } from "./MissileSiloExecution";
import { PlayerExecution } from "./PlayerExecution";
import { PortExecution } from "./PortExecution";
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
    case "city": {
      const data = cp.data as {
        cityId: number;
        stationCreated: boolean;
        active: boolean;
      };
      const city = game.unit(data.cityId);
      if (city === undefined) return undefined;
      const exec = new CityExecution(city);
      if (initialize) exec.init(game, ticks);
      exec.restoreCheckpoint(data);
      return exec;
    }
    case "factory": {
      const data = cp.data as {
        factoryId: number;
        stationCreated: boolean;
        active: boolean;
      };
      const factory = game.unit(data.factoryId);
      if (factory === undefined) return undefined;
      const exec = new FactoryExecution(factory);
      if (initialize) exec.init(game, ticks);
      exec.restoreCheckpoint(data);
      return exec;
    }
    case "missile_silo": {
      const data = cp.data as { siloId: number; active: boolean };
      const silo = game.unit(data.siloId);
      if (silo === undefined) return undefined;
      const exec = new MissileSiloExecution(silo);
      if (initialize) exec.init(game, ticks);
      exec.restoreCheckpoint(data);
      return exec;
    }
    case "defense_post": {
      const data = cp.data as {
        postId: number;
        active: boolean;
        targetId: number | null;
        lastShellAttack: number;
        alreadySentShellIds: number[];
      };
      const post = game.unit(data.postId);
      if (post === undefined) return undefined;
      const exec = new DefensePostExecution(post);
      if (initialize) exec.init(game, ticks);
      exec.restoreCheckpoint(data);
      return exec;
    }
    case "port": {
      const data = cp.data as {
        portId: number;
        active: boolean;
        random: PseudoRandomState;
        checkOffset: number;
        tradeShipSpawnRejections: number;
        stationCreated: boolean;
      };
      const port = game.unit(data.portId);
      if (port === undefined) return undefined;
      const exec = new PortExecution(port);
      if (initialize) exec.init(game, ticks);
      exec.restoreCheckpoint(data);
      return exec;
    }
    case "construction": {
      const data = cp.data as {
        playerId: string;
        constructionType: UnitType;
        tile: number;
        rocketDirectionUp: boolean | null;
        amount: number | null;
        structureId: number | null;
        active: boolean;
        ticksUntilComplete: number | null;
      };
      if (!game.hasPlayer(data.playerId)) return undefined;
      const exec = new ConstructionExecution(
        game.player(data.playerId),
        data.constructionType,
        data.tile,
        data.rocketDirectionUp ?? undefined,
        data.amount ?? undefined,
      );
      if (initialize) exec.init(game, ticks);
      exec.restoreCheckpoint(data);
      return exec;
    }
    default:
      return undefined;
  }
}
