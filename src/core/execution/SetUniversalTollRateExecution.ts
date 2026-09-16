import { Execution, Game, Player } from "../game/Game";

/**
 * Sets the universal minimum percentage (0-100) this player's Tollhouses
 * charge every other nation. A nation's effective rate is the greater of this
 * floor and its per-nation rate; 0 clears the floor.
 */
export class SetUniversalTollRateExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private readonly percent: number,
  ) {}

  init(_: Game, __: number): void {
    this.active = true;
  }

  tick(_: number): void {
    this.player.setUniversalTollRate(this.percent);
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
