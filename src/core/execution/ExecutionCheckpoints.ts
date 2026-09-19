import { ExecutionCheckpoint } from "../Checkpoint";
import { Execution, Game, UnitType } from "../game/Game";
import { PseudoRandomState } from "../PseudoRandom";
import { AttackExecution, AttackExecutionCheckpoint } from "./AttackExecution";
import { CityExecution } from "./CityExecution";
import { ConstructionExecution } from "./ConstructionExecution";
import { DefensePostExecution } from "./DefensePostExecution";
import {
  DeleteUnitExecution,
  DeleteUnitExecutionCheckpoint,
} from "./DeleteUnitExecution";
import { FactoryExecution } from "./FactoryExecution";
import {
  MissileDefenseShipExecution,
  MissileDefenseShipExecutionCheckpoint,
} from "./MissileDefenseShipExecution";
import {
  MissileShipExecution,
  MissileShipExecutionCheckpoint,
} from "./MissileShipExecution";
import { MissileSiloExecution } from "./MissileSiloExecution";
import { NationExecution, NationExecutionCheckpoint } from "./NationExecution";
import { PlayerExecution } from "./PlayerExecution";
import { PortExecution } from "./PortExecution";
import { RecomputeRailClusterExecution } from "./RecomputeRailClusterExecution";
import {
  RetreatExecution,
  RetreatExecutionCheckpoint,
} from "./RetreatExecution";
import { SpawnTimerExecution } from "./SpawnTimerExecution";
import {
  TradeShipExecution,
  TradeShipExecutionCheckpoint,
} from "./TradeShipExecution";
import {
  TransportShipExecution,
  TransportShipExecutionCheckpoint,
} from "./TransportShipExecution";
import { TribeExecution, TribeExecutionCheckpoint } from "./TribeExecution";
import {
  WarshipExecution,
  WarshipExecutionCheckpoint,
} from "./WarshipExecution";
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
    case "nation": {
      const data = cp.data as NationExecutionCheckpoint;
      const nation = game
        .nations()
        .find((n) => n.playerInfo.id === data.playerId);
      if (nation === undefined) return undefined;
      const exec = new NationExecution(data.gameID, nation);
      exec.restoreCheckpoint(game, data, initialize);
      return exec;
    }
    case "tribe": {
      const data = cp.data as TribeExecutionCheckpoint;
      if (!game.hasPlayer(data.playerId)) return undefined;
      const exec = new TribeExecution(game.player(data.playerId));
      exec.restoreCheckpoint(game, data, initialize);
      return exec;
    }
    case "attack": {
      const data = cp.data as AttackExecutionCheckpoint;
      if (!game.hasPlayer(data.ownerId)) return undefined;
      const exec = new AttackExecution(
        data.startTroops,
        game.player(data.ownerId),
        data.targetId,
        data.sourceTile,
        data.removeTroops,
      );
      if (!exec.restoreCheckpoint(game, data)) return undefined;
      return exec;
    }
    case "retreat": {
      const data = cp.data as RetreatExecutionCheckpoint;
      if (!game.hasPlayer(data.playerId)) return undefined;
      const exec = new RetreatExecution(
        game.player(data.playerId),
        data.attackID,
      );
      exec.restoreCheckpoint(game, data);
      return exec;
    }
    case "delete_unit": {
      const data = cp.data as DeleteUnitExecutionCheckpoint;
      if (!game.hasPlayer(data.playerId)) return undefined;
      const exec = new DeleteUnitExecution(
        game.player(data.playerId),
        data.unitId,
      );
      exec.restoreCheckpoint(game, data);
      return exec;
    }
    case "trade_ship": {
      const data = cp.data as TradeShipExecutionCheckpoint;
      if (!game.hasPlayer(data.origOwnerId)) return undefined;
      const srcPort = game.unit(data.srcPortId);
      const dstPort = game.unit(data.dstPortId);
      if (srcPort === undefined || dstPort === undefined) return undefined;
      const exec = new TradeShipExecution(
        game.player(data.origOwnerId),
        srcPort,
        dstPort,
      );
      if (!exec.restoreCheckpoint(game, data)) return undefined;
      return exec;
    }
    case "transport_ship": {
      const data = cp.data as TransportShipExecutionCheckpoint;
      if (!game.hasPlayer(data.attackerId)) return undefined;
      const exec = new TransportShipExecution(
        game.player(data.attackerId),
        data.ref,
        data.troops,
        data.escort,
      );
      if (!exec.restoreCheckpoint(game, data)) return undefined;
      return exec;
    }
    case "warship": {
      const data = cp.data as WarshipExecutionCheckpoint;
      if (data.warshipId === null) return undefined;
      const warship = game.unit(data.warshipId);
      if (warship === undefined) return undefined;
      const exec = new WarshipExecution(warship);
      if (!exec.restoreCheckpoint(game, data)) return undefined;
      return exec;
    }
    case "missile_ship": {
      const data = cp.data as MissileShipExecutionCheckpoint;
      if (data.warshipId === null) return undefined;
      const warship = game.unit(data.warshipId);
      if (warship === undefined) return undefined;
      const exec = new MissileShipExecution(warship);
      if (!exec.restoreCheckpoint(game, data)) return undefined;
      return exec;
    }
    case "missile_defense_ship": {
      const data = cp.data as MissileDefenseShipExecutionCheckpoint;
      if (data.warshipId === null) return undefined;
      const warship = game.unit(data.warshipId);
      if (warship === undefined) return undefined;
      const exec = new MissileDefenseShipExecution(warship);
      if (!exec.restoreCheckpoint(game, data)) return undefined;
      return exec;
    }
    default:
      return undefined;
  }
}
