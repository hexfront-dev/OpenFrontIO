import { Execution, Game, Player, PlayerID } from "../game/Game";

/**
 * Sets the percentage (0-100) this player's Tollhouses charge the trade ships
 * of the target nation. A percentage of 0 clears the setting.
 */
export class SetTollRateExecution implements Execution {
  private active = true;

  private target: Player;

  constructor(
    private player: Player,
    private targetID: PlayerID,
    private readonly percent: number,
  ) {}

  init(mg: Game, _: number): void {
    if (!mg.hasPlayer(this.targetID)) {
      console.warn(`SetTollRateExecution recipient ${this.targetID} not found`);
      this.active = false;
      return;
    }
    this.target = mg.player(this.targetID);
  }

  tick(_: number): void {
    this.player.setTollRate(this.target, this.percent);
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
