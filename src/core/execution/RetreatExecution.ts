import { ExecutionCheckpoint } from "../Checkpoint";
import { Execution, Game, Player } from "../game/Game";

const cancelDelay = 20;

export interface RetreatExecutionCheckpoint {
  playerId: string;
  attackID: string;
  active: boolean;
  retreatOrdered: boolean;
  startTick: number;
}

export class RetreatExecution implements Execution {
  private active = true;
  private retreatOrdered = false;
  private startTick: number;
  private mg: Game;
  constructor(
    private player: Player,
    private attackID: string,
  ) {}

  /** B2: capture the retreat countdown. */
  checkpoint(): ExecutionCheckpoint {
    return {
      kind: "retreat",
      data: {
        playerId: this.player.id(),
        attackID: this.attackID,
        active: this.active,
        retreatOrdered: this.retreatOrdered,
        startTick: this.startTick,
      } satisfies RetreatExecutionCheckpoint,
    };
  }

  /** B2: overwrite the retreat countdown from a checkpoint (never re-init). */
  restoreCheckpoint(game: Game, data: RetreatExecutionCheckpoint): void {
    this.mg = game;
    this.active = data.active;
    this.retreatOrdered = data.retreatOrdered;
    this.startTick = data.startTick;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.startTick = mg.ticks();
  }

  tick(ticks: number): void {
    if (!this.retreatOrdered) {
      this.player.orderRetreat(this.attackID);
      this.retreatOrdered = true;
    }

    if (this.mg.ticks() >= this.startTick + cancelDelay) {
      this.player.executeRetreat(this.attackID);
      this.active = false;
    }
  }

  owner(): Player {
    return this.player;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
