import { ExecutionCheckpoint } from "../Checkpoint";
import { Execution, Game } from "../game/Game";

export class SpawnTimerExecution implements Execution {
  private mg: Game;

  checkpoint(): ExecutionCheckpoint {
    return { kind: "spawntimer", data: {} };
  }

  restoreCheckpoint(_data: Record<string, never>): void {}

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(): void {
    if (this.mg.ticks() > this.mg.config().numSpawnPhaseTurns()) {
      this.mg.endSpawnPhase();
    }
  }

  isActive(): boolean {
    return this.mg.inSpawnPhase();
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }
}
