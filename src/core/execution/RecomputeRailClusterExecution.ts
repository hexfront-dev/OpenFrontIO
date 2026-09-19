import { ExecutionCheckpoint } from "../Checkpoint";
import { Execution, Game } from "../game/Game";
import { RailNetwork } from "../game/RailNetwork";

export class RecomputeRailClusterExecution implements Execution {
  constructor(private railNetwork: RailNetwork) {}

  checkpoint(): ExecutionCheckpoint {
    return { kind: "recompute_rail_cluster", data: {} };
  }

  restoreCheckpoint(_data: Record<string, never>): void {}

  isActive(): boolean {
    return true;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {}

  tick(ticks: number): void {
    this.railNetwork.recomputeClusters();
  }
}
