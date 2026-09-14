import { Execution, Player } from "../game/Game";
import { TileRef } from "../game/GameMap";

/**
 * Applies a control+drag "avoid" selection to one of the player's ongoing
 * attacks. Each tile in the intent is toggled in the attack's avoidance set:
 * already-avoided tiles are re-enabled, new tiles are excluded from conquest.
 *
 * The tiles are only meaningful while they sit on the attack's front line
 * (AttackExecution skips avoided tiles), so avoiding a tile the attack has
 * already moved past is harmless.
 */
export class AvoidConquestExecution implements Execution {
  private active = true;

  constructor(
    private readonly player: Player,
    private readonly attackID: string,
    private readonly tiles: TileRef[],
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(): void {}

  tick(): void {
    const attack = this.player
      .outgoingAttacks()
      .find((a) => a.id() === this.attackID);
    if (attack !== undefined && attack.isActive()) {
      for (const tile of this.tiles) {
        if (attack.isAvoided(tile)) {
          attack.removeAvoidedTile(tile);
        } else {
          attack.addAvoidedTile(tile);
        }
      }
    }
    this.active = false;
  }

  owner(): Player {
    return this.player;
  }

  isActive(): boolean {
    return this.active;
  }
}
