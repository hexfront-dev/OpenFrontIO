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
 * region of the frontline from the player's ongoing conquest attempts.
 *
 * The player drags a rectangle; every frontier tile of an outgoing attack
 * that falls inside it is toggled (excluded tiles are re-enabled, new tiles
 * are excluded). Excluded tiles are skipped by the attack's conquest loop on
 * the server-authoritative core, so they are never conquered while avoided.
 *
 * Avoidance state is tracked here optimistically (only the local player can
 * modify their own attacks), and the same toggles are relayed to the core via
 * `avoid_conquest` intents so every client agrees deterministically.
 */
export class AvoidConquestController implements Controller {
  // attackID → avoided TileRefs. Authoritative for the local player (they are
  // the only actor that can toggle these), and mirrored by the core.
  private avoidedByAttack = new Map<string, Set<TileRef>>();

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
    this.pruneStaleAttacks();
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

    const attacks = myPlayer.outgoingAttacks();
    for (const [targetID, tiles] of this.frontierTilesInRect(
      rect.x1,
      rect.y1,
      rect.x2,
      rect.y2,
    )) {
      const attack = attacks.find((a) => a.targetID === targetID);
      if (attack === undefined) continue;

      const set = this.avoidedByAttack.get(attack.id) ?? new Set<TileRef>();
      this.avoidedByAttack.set(attack.id, set);

      const toggled: TileRef[] = [];
      for (const tile of tiles) {
        if (set.has(tile)) {
          set.delete(tile);
        } else {
          set.add(tile);
        }
        toggled.push(tile);
      }

      if (toggled.length > 0) {
        this.eventBus.emit(
          new SendAvoidConquestIntentEvent(attack.id, toggled),
        );
      }
    }

    this.renderAvoided();
  }

  /**
   * Frontier tiles of the local player's attacks that fall inside the given
   * (inclusive) world-tile rectangle, grouped by the target's smallID. A
   * frontier tile is land owned by a target (anyone but the local player)
   * that is 4-adjacent to the local player's territory.
   */
  private frontierTilesInRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): Map<number, TileRef[]> {
    const myID = this.game.myPlayer()?.smallID() ?? -1;
    const result = new Map<number, TileRef[]>();
    const nbuf: TileRef[] = [0, 0, 0, 0];

    const minX = Math.max(0, x1);
    const minY = Math.max(0, y1);
    const maxX = Math.min(this.game.width() - 1, x2);
    const maxY = Math.min(this.game.height() - 1, y2);

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

        let tiles = result.get(owner);
        if (tiles === undefined) {
          tiles = [];
          result.set(owner, tiles);
        }
        tiles.push(ref);
      }
    }
    return result;
  }

  private pruneStaleAttacks(): void {
    const myPlayer = this.game.myPlayer();
    const activeIDs = new Set<string>();
    if (myPlayer) {
      for (const attack of myPlayer.outgoingAttacks()) {
        activeIDs.add(attack.id);
      }
    }
    let pruned = false;
    for (const id of this.avoidedByAttack.keys()) {
      if (!activeIDs.has(id)) {
        this.avoidedByAttack.delete(id);
        pruned = true;
      }
    }
    if (pruned) {
      this.renderAvoided();
    }
  }

  /** Push the union of all avoided tiles to the renderer. */
  private renderAvoided(): void {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) {
      this.view.updateAvoidedTiles({ tiles: [] });
      return;
    }

    const activeIDs = new Set(myPlayer.outgoingAttacks().map((a) => a.id));
    const tiles: { x: number; y: number }[] = [];
    for (const [attackID, set] of this.avoidedByAttack) {
      if (!activeIDs.has(attackID)) continue;
      for (const ref of set) {
        tiles.push({ x: this.game.x(ref), y: this.game.y(ref) });
      }
    }
    this.view.updateAvoidedTiles({ tiles });
  }
}
