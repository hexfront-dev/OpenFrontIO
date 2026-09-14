import { EventBus } from "../../core/EventBus";
import { TileRef } from "../../core/game/GameMap";
import { Controller } from "../Controller";
import {
  AvoidConquestBoxCancelEvent,
  AvoidConquestBoxCompleteEvent,
  AvoidConquestBoxUpdateEvent,
  CloseViewEvent,
} from "../InputHandler";
import { MapRenderer } from "../render/gl";
import { TransformHandler } from "../TransformHandler";
import { SendAvoidConquestIntentEvent } from "../Transport";
import { GameView } from "../view";

/**
 * AvoidConquestController — handles the ctrl+drag gesture that excludes a
 * region of the frontline from the player's conquest attempts.
 *
 * The player drags a rectangle; every frontier tile that falls inside it is
 * toggled (excluded tiles are re-enabled, new tiles are excluded). Excluded
 * tiles are skipped by every attack's conquest loop in the core, and they stay
 * excluded across attacks until toggled off again.
 *
 * Avoidance state is tracked here optimistically (only the local player can
 * modify their own exclusions), and the same toggles are relayed to the core
 * via `avoid_conquest` intents so every client agrees deterministically.
 */
export class AvoidConquestController implements Controller {
  // Authoritative-for-local-player mirror of the core's per-player exclusion
  // set. Only the local player toggles these, and the core applies the same
  // toggles deterministically.
  private avoided = new Set<TileRef>();

  // Screen-space DOM overlay drawn while the user is dragging the rectangle.
  private dragRectEl: HTMLDivElement | null = null;

  constructor(
    private readonly game: GameView,
    private readonly eventBus: EventBus,
    private readonly transformHandler: TransformHandler,
    private readonly view: MapRenderer,
  ) {}

  init() {
    this.ensureDragRectEl();
    this.eventBus.on(AvoidConquestBoxUpdateEvent, (e) => this.onBoxUpdate(e));
    this.eventBus.on(AvoidConquestBoxCompleteEvent, (e) =>
      this.onBoxComplete(e),
    );
    const clear = () => this.clearBox();
    this.eventBus.on(AvoidConquestBoxCancelEvent, clear);
    this.eventBus.on(CloseViewEvent, clear);
  }

  tick() {
    this.renderAvoided();
  }

  private ensureDragRectEl(): void {
    if (this.dragRectEl !== null) return;
    const el = document.createElement("div");
    el.id = "avoid-conquest-drag-rect";
    el.style.position = "fixed";
    el.style.pointerEvents = "none";
    el.style.display = "none";
    el.style.zIndex = "30";
    el.style.borderStyle = "dashed";
    el.style.borderWidth = "1px";
    el.style.boxSizing = "border-box";
    document.body.appendChild(el);
    this.dragRectEl = el;
  }

  private onBoxUpdate(e: AvoidConquestBoxUpdateEvent): void {
    const el = this.dragRectEl;
    if (el === null) return;
    const x1 = Math.min(e.startX, e.endX);
    const y1 = Math.min(e.startY, e.endY);
    const w = Math.abs(e.endX - e.startX);
    const h = Math.abs(e.endY - e.startY);
    el.style.left = `${x1}px`;
    el.style.top = `${y1}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.borderColor = "rgba(255, 120, 30, 0.9)";
    el.style.backgroundColor = "rgba(255, 120, 30, 0.08)";
    el.style.display = "block";
  }

  private clearBox(): void {
    if (this.dragRectEl !== null) this.dragRectEl.style.display = "none";
  }

  private onBoxComplete(e: AvoidConquestBoxCompleteEvent): void {
    this.clearBox();

    const myPlayer = this.game.myPlayer();
    if (!myPlayer || !myPlayer.isAlive()) {
      this.renderAvoided();
      return;
    }

    const start = this.transformHandler.screenToWorldCoordinates(
      e.startX,
      e.startY,
    );
    const end = this.transformHandler.screenToWorldCoordinates(e.endX, e.endY);
    const rect = {
      x1: Math.min(start.x, end.x),
      y1: Math.min(start.y, end.y),
      x2: Math.max(start.x, end.x),
      y2: Math.max(start.y, end.y),
    };

    const toggled: TileRef[] = [];
    for (const tile of this.frontierTilesInRect(
      rect.x1,
      rect.y1,
      rect.x2,
      rect.y2,
    )) {
      if (this.avoided.has(tile)) {
        this.avoided.delete(tile);
      } else {
        this.avoided.add(tile);
      }
      toggled.push(tile);
    }

    if (toggled.length > 0) {
      this.eventBus.emit(new SendAvoidConquestIntentEvent(toggled));
    }

    this.renderAvoided();
  }

  /**
   * Frontier tiles that fall inside the given (inclusive) world-tile
   * rectangle. A frontier tile is land owned by anyone but the local player
   * that is 4-adjacent to the local player's territory. This is independent of
   * any specific attack, so exclusions can be marked before or between attacks.
   */
  private frontierTilesInRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): TileRef[] {
    const myID = this.game.myPlayer()?.smallID() ?? -1;
    const result: TileRef[] = [];
    const nbuf: TileRef[] = [0, 0, 0, 0];

    const minX = Math.max(0, Math.floor(x1));
    const minY = Math.max(0, Math.floor(y1));
    const maxX = Math.min(this.game.width() - 1, Math.floor(x2));
    const maxY = Math.min(this.game.height() - 1, Math.floor(y2));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const ref = this.game.ref(x, y);
        const owner = this.game.ownerID(ref);
        if (owner === myID) continue;
        if (this.game.isWater(ref) || this.game.isImpassable(ref)) continue;

        const n = this.game.neighbors4(ref, nbuf);
        let onFrontier = false;
        for (let i = 0; i < n; i++) {
          if (this.game.ownerID(nbuf[i]) === myID) {
            onFrontier = true;
            break;
          }
        }
        if (!onFrontier) continue;

        result.push(ref);
      }
    }
    return result;
  }

  /** Push the excluded tiles (minus any the player now owns) to the renderer. */
  private renderAvoided(): void {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) {
      this.view.updateAvoidedTiles({ tiles: [] });
      return;
    }

    const myID = myPlayer.smallID();
    const tiles: { x: number; y: number }[] = [];
    for (const ref of this.avoided) {
      // A tile the player now owns is no longer "excluded from conquest" —
      // hide its marker (e.g. after a whole-player elimination conquers it).
      if (this.game.ownerID(ref) === myID) continue;
      tiles.push({ x: this.game.x(ref), y: this.game.y(ref) });
    }
    this.view.updateAvoidedTiles({ tiles });
  }
}
