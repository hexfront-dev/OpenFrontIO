import { Execution, Player } from "../game/Game";
import { TileRef } from "../game/GameMap";

/**
 * Applies a control+drag "avoid" selection to the player's persistent
 * conquest-exclusion set. Each tile in the intent is toggled: already-excluded
 * tiles are re-enabled, new tiles are excluded from conquest.
 *
 * The set lives on the player (not on any one attack), so an exclusion persists
 * across attacks — every attack the player launches consults the same set — and
 * only flips when the same tile is toggled again. Toggling happens in init()
 * rather than tick() so it takes effect for the very next attack tick.
 */
export class AvoidConquestExecution implements Execution {
  private active = true;

  constructor(
    private readonly player: Player,
    private readonly tiles: TileRef[],
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(): void {
    for (const tile of this.tiles) {
      if (this.player.isAvoidedTile(tile)) {
        this.player.removeAvoidedTile(tile);
      } else {
        this.player.addAvoidedTile(tile);
      }
    }
    this.active = false;
  }

  tick(): void {}

  owner(): Player {
    return this.player;
  }

  isActive(): boolean {
    return this.active;
  }
}
