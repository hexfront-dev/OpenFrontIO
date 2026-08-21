import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { css } from "lit";
import { EventBus } from "../../../core/EventBus";
import { MAX_FLEET_SIZE, WarShips } from "../../../core/game/Game";
import { Controller } from "../../Controller";
import { GameView, UnitView } from "../../../core/game/GameView";
import { UnitSelectionEvent, CreateFleetEvent } from "../../InputHandler";

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
    .fleet-dismiss {
      color: #f44;
      cursor: pointer;
      font-weight: bold;
      font-size: 14px;
      padding: 0 4px;
      line-height: 1;
      user-select: none;
    }
    .fleet-dismiss:hover {
      color: #f88;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
    }
  `;

  init() {}

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
    for (const unit of myPlayer.units(...WarShips.types)) {
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
          <div class="fleet-entry">
            <span class="fleet-name" @click=${() => this.selectFleet(units)}>Fleet ${fleetId}</span>
            <span class="fleet-count" @click=${() => this.selectFleet(units)}>${units.length}/${MAX_FLEET_SIZE}</span>
            <span class="fleet-dismiss" @pointerdown=${(e: Event) => e.stopPropagation()} @pointerup=${(e: Event) => { e.stopPropagation(); e.preventDefault(); this.dismissFleet(units); }}>x</span>
          </div>
        `,
      )}
    `;
  }

  private selectFleet(units: UnitView[]) {
    this.eventBus?.emit(new UnitSelectionEvent(null, true, units));
  }

  private dismissFleet(units: UnitView[]) {
    this.eventBus?.emit(new CreateFleetEvent(units.map((u) => u.id())));
  }
}
