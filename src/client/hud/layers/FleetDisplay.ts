import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { css } from "lit";
import { EventBus } from "../../../core/EventBus";
import { UnitType } from "../../../core/game/Game";
import { Controller } from "../../Controller";
import { GameView, UnitView } from "../../../core/game/GameView";
import { UnitSelectionEvent } from "../../InputHandler";

@customElement("fleet-display")
export class FleetDisplay extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state()
  private fleets: Map<number, UnitView[]> = new Map();

  static styles = css`
    :host {
      display: block;
      position: fixed;
      right: 10px;
      top: 60px;
      width: 180px;
      max-height: calc(100vh - 80px);
      overflow-y: auto;
      z-index: 100;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      padding: 6px;
      font-family: sans-serif;
      font-size: 12px;
      color: #ccc;
      pointer-events: auto;
    }
    .fleet-entry {
      padding: 3px 4px;
      margin: 2px 0;
      cursor: pointer;
      border-radius: 2px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .fleet-entry:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .fleet-name {
      color: #fff;
      font-weight: bold;
    }
    .fleet-count {
      color: #aaa;
      font-size: 10px;
    }
  `;

  init() {
    this.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.addEventListener("pointerup", (e) => e.stopPropagation());
  }

  tick() {
    this.refreshFleets();
  }

  private refreshFleets() {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) {
      this.fleets = new Map();
      return;
    }

    const fleetMap = new Map<number, UnitView[]>();
    for (const unit of myPlayer.units(UnitType.Warship)) {
      const fid = unit.fleetId();
      if (fid === undefined) continue;
      if (!fleetMap.has(fid)) {
        fleetMap.set(fid, []);
      }
      fleetMap.get(fid)!.push(unit);
    }
    this.fleets = fleetMap;
  }

  render() {
    if (this.fleets.size === 0) return html``;

    return html`
      ${[...this.fleets.entries()].map(
        ([fleetId, units]) => html`
          <div class="fleet-entry" @click=${() => this.selectFleet(units)}>
            <span class="fleet-name">Fleet ${fleetId}</span>
            <span class="fleet-count">${units.length} ship${units.length !== 1 ? "s" : ""}</span>
          </div>
        `,
      )}
    `;
  }

  private selectFleet(units: UnitView[]) {
    this.eventBus.emit(new UnitSelectionEvent(null, true, units));
  }
}
