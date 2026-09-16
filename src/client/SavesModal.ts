import { html, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { ClientID, SavedGame, SavedGameMeta } from "../core/Schemas";
import {
  deleteSavedLobby,
  listSavedLobbies,
  resumeSavedLobby,
  type ResumableSeat,
  type SavedLobbySummary,
} from "./Api";
import { ClientEnv } from "./ClientEnv";
import type { JoinLobbyEvent } from "./Main";
import { deleteSave, listSaves, loadSave } from "./SaveStore";
import { translateText } from "./Utils";
import { BaseModal } from "./components/BaseModal";
import "./components/baseComponents/Button";
import "./components/baseComponents/Modal";
import { modalHeader } from "./components/ui/ModalHeader";

function commitMatches(saveGitCommit: string): boolean {
  const current = ClientEnv.gitCommit();
  if (current === "DEV" || saveGitCommit === "DEV") {
    return true;
  }
  return saveGitCommit === current;
}

@customElement("saves-modal")
export class SavesModal extends BaseModal {
  protected routerName = "load-game";

  // Local (browser) saves.
  @state() private saves: SavedGameMeta[] | null = null;
  @state() private selected: SavedGame | null = null;

  // Server-hosted saves the host can resume as a private lobby.
  @state() private serverSaves: SavedLobbySummary[] | null = null;
  @state() private selectedServer: SavedLobbySummary | null = null;
  @state() private serverSeats: ResumableSeat[] | null = null;
  // null = watch only (no seat claimed); otherwise the saved nation to control.
  @state() private chosenSeat: ClientID | null = null;

  @state() private myClientID: ClientID | null = null;
  @state() private error = "";

  protected renderHeaderSlot() {
    const onBack = this.selectedServer
      ? () => this.clearServerSelection()
      : this.selected
        ? () => this.clearSelection()
        : () => this.close();
    return modalHeader({
      title: translateText("save_game.title") || "Saved games",
      onBack,
      ariaLabel: translateText("common.back"),
    });
  }

  protected onOpen(): void {
    this.selected = null;
    this.selectedServer = null;
    this.serverSeats = null;
    this.myClientID = null;
    this.error = "";
    void this.refresh();
  }

  protected onClose(): void {
    this.selected = null;
    this.selectedServer = null;
    this.serverSeats = null;
    this.myClientID = null;
    this.error = "";
    this.saves = null;
    this.serverSaves = null;
  }

  private async refresh(): Promise<void> {
    try {
      this.saves = await listSaves();
    } catch (error) {
      console.error("Failed to list saves", error);
      this.saves = [];
      this.error = translateText("save_game.load_failed");
    }
    try {
      this.serverSaves = await listSavedLobbies();
    } catch (error) {
      console.error("Failed to list server saves", error);
      this.serverSaves = [];
    }
  }

  private clearSelection(): void {
    this.selected = null;
    this.myClientID = null;
    this.error = "";
  }

  private clearServerSelection(): void {
    this.selectedServer = null;
    this.serverSeats = null;
    this.chosenSeat = null;
    this.error = "";
  }

  // --- Local saves -------------------------------------------------------

  private async selectSave(meta: SavedGameMeta): Promise<void> {
    try {
      const save = await loadSave(meta.saveId);
      if (save === undefined) {
        this.error = translateText("save_game.missing");
        return;
      }
      this.selected = save;
      this.myClientID =
        save.myClientID ?? save.startInfo.players[0]?.clientID ?? null;
      if (!commitMatches(save.gitCommit)) {
        this.error = translateText("save_game.version_mismatch");
      }
    } catch (error) {
      console.error("Failed to load save", error);
      this.error = translateText("save_game.load_failed");
    }
  }

  private async removeSave(meta: SavedGameMeta, event: Event): Promise<void> {
    event.stopPropagation();
    try {
      await deleteSave(meta.saveId);
      if (this.selected?.saveId === meta.saveId) {
        this.clearSelection();
      }
      await this.refresh();
    } catch (error) {
      console.error("Failed to delete save", error);
    }
  }

  private resumeLocal(): void {
    const save = this.selected;
    const clientID = this.myClientID;
    if (!save || !clientID || !commitMatches(save.gitCommit)) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: save.startInfo.gameID,
          resume: {
            startInfo: save.startInfo,
            turns: save.turns,
            myClientID: clientID,
          },
          source: "private",
        } satisfies JoinLobbyEvent,
        bubbles: true,
        composed: true,
      }),
    );
    this.close();
  }

  // --- Server-hosted lobbies --------------------------------------------

  private async selectServerSave(meta: SavedLobbySummary): Promise<void> {
    try {
      // The resume call both rebuilds the game on its worker and returns the
      // seats that can still be claimed.
      this.serverSeats = await resumeSavedLobby(meta.gameID);
      this.selectedServer = meta;
      this.chosenSeat =
        this.serverSeats.find((s) => !s.claimed)?.clientID ?? null;
      if (!commitMatches(meta.gitCommit)) {
        this.error = translateText("save_game.version_mismatch");
      }
    } catch (error) {
      console.error("Failed to resume saved lobby", error);
      this.error = translateText("save_game.resume_failed");
    }
  }

  private async removeServerSave(
    meta: SavedLobbySummary,
    event: Event,
  ): Promise<void> {
    event.stopPropagation();
    try {
      await deleteSavedLobby(meta.gameID);
      if (this.selectedServer?.gameID === meta.gameID) {
        this.clearServerSelection();
      }
      await this.refresh();
    } catch (error) {
      console.error("Failed to delete server save", error);
    }
  }

  private resumeServer(): void {
    const meta = this.selectedServer;
    if (!meta || !commitMatches(meta.gitCommit)) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: meta.gameID,
          claimClientID: this.chosenSeat ?? undefined,
          spectator: this.chosenSeat === null ? true : undefined,
          source: "private",
        } satisfies JoinLobbyEvent,
        bubbles: true,
        composed: true,
      }),
    );
    this.close();
  }

  // --- Render ------------------------------------------------------------

  protected renderBody(): TemplateResult {
    if (this.selectedServer) {
      return this.renderServerSeatPicker(this.selectedServer);
    }
    if (this.selected) {
      return this.renderNationPicker();
    }
    return this.renderList();
  }

  private renderList(): TemplateResult {
    if (this.saves === null || this.serverSaves === null) {
      return this.renderLoadingSpinner(translateText("save_game.loading"));
    }
    return html`
      <div class="flex flex-col gap-3 p-4">
        ${this.error
          ? html`<p class="text-sm text-yellow-400">${this.error}</p>`
          : nothing}
        <h3
          class="text-sm font-semibold uppercase tracking-wider text-white/50"
        >
          ${translateText("save_game.server_section")}
        </h3>
        ${this.serverSaves.length === 0
          ? html`<p class="text-white/40 text-sm">
              ${translateText("save_game.server_empty")}
            </p>`
          : this.serverSaves.map((meta) => this.renderServerRow(meta))}
        <h3
          class="text-sm font-semibold uppercase tracking-wider text-white/50 mt-2"
        >
          ${translateText("save_game.title")}
        </h3>
        ${this.saves.length === 0
          ? html`<p class="text-white/40 text-sm">
              ${translateText("save_game.empty")}
            </p>`
          : this.saves.map((meta) => this.renderRow(meta))}
      </div>
    `;
  }

  private renderRow(meta: SavedGameMeta): TemplateResult {
    return html`
      <div
        class="flex items-center justify-between gap-4 p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 cursor-pointer transition-colors"
        @click=${() => void this.selectSave(meta)}
      >
        <div class="flex flex-col min-w-0">
          <span class="font-semibold text-white truncate">${meta.label}</span>
          <span class="text-xs text-white/50 truncate">
            ${meta.playerNames.join(", ")}
          </span>
          <span class="text-xs text-white/40">
            ${meta.gameMap} · ${meta.playerCount}
            ${translateText("save_game.players")} · ${meta.numTurns}
            ${translateText("save_game.turns")} ·
            ${new Date(meta.savedAt).toLocaleString()}
          </span>
        </div>
        <button
          class="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30"
          @click=${(e: Event) => void this.removeSave(meta, e)}
        >
          ${translateText("save_game.delete")}
        </button>
      </div>
    `;
  }

  private renderServerRow(meta: SavedLobbySummary): TemplateResult {
    return html`
      <div
        class="flex items-center justify-between gap-4 p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 cursor-pointer transition-colors"
        @click=${() => void this.selectServerSave(meta)}
      >
        <div class="flex flex-col min-w-0">
          <span class="font-semibold text-white truncate">${meta.label}</span>
          <span class="text-xs text-white/40">
            ${meta.gameMap} · ${meta.playerCount}
            ${translateText("save_game.players")} · ${meta.numTurns}
            ${translateText("save_game.turns")} ·
            ${new Date(meta.savedAt).toLocaleString()}
          </span>
        </div>
        <span
          class="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider bg-malibu-blue/20 text-white border border-malibu-blue/30"
        >
          ${translateText("save_game.resume_lobby")}
        </span>
        <button
          class="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30"
          @click=${(e: Event) => void this.removeServerSave(meta, e)}
        >
          ${translateText("save_game.delete")}
        </button>
      </div>
    `;
  }

  private renderNationPicker(): TemplateResult {
    const save = this.selected!;
    const blocked = !commitMatches(save.gitCommit);
    return html`
      <div class="flex flex-col h-full">
        <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
          <p class="text-sm text-white/60 mb-3">
            ${translateText("save_game.choose_nation")}
          </p>
          ${this.error
            ? html`<p class="text-sm text-yellow-400 mb-3">${this.error}</p>`
            : nothing}
          <div class="flex flex-col gap-2">
            ${save.startInfo.players.map((player) =>
              this.renderPlayerRow(player.clientID, player.username),
            )}
          </div>
        </div>
        <div class="p-4 border-t border-white/10 bg-black/20">
          <o-button
            variant="primary"
            width="block"
            size="lg"
            translationKey="save_game.resume"
            .disable=${blocked || this.myClientID === null}
            @click=${this.resumeLocal}
          ></o-button>
        </div>
      </div>
    `;
  }

  private renderServerSeatPicker(meta: SavedLobbySummary): TemplateResult {
    const blocked = !commitMatches(meta.gitCommit);
    const seats = this.serverSeats ?? [];
    return html`
      <div class="flex flex-col h-full">
        <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
          <p class="text-sm text-white/60 mb-3">
            ${translateText("save_game.choose_nation")}
          </p>
          ${this.error
            ? html`<p class="text-sm text-yellow-400 mb-3">${this.error}</p>`
            : nothing}
          <div class="flex flex-col gap-2">
            ${seats.map((seat) =>
              this.renderSeatRow(seat.clientID, seat.username, seat.claimed),
            )}
            <label
              class="flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${this
                .chosenSeat === null
                ? "border-malibu-blue bg-malibu-blue/10"
                : "border-white/10 bg-white/5 hover:bg-white/10"}"
            >
              <input
                type="radio"
                name="server-nation"
                class="accent-malibu-blue"
                .checked=${this.chosenSeat === null}
                @change=${() => (this.chosenSeat = null)}
              />
              <span class="text-white"
                >${translateText("save_game.spectate")}</span
              >
            </label>
          </div>
        </div>
        <div class="p-4 border-t border-white/10 bg-black/20">
          <o-button
            variant="primary"
            width="block"
            size="lg"
            translationKey="save_game.resume_lobby"
            .disable=${blocked}
            @click=${this.resumeServer}
          ></o-button>
        </div>
      </div>
    `;
  }

  private renderSeatRow(
    clientID: string,
    username: string,
    claimed: boolean,
  ): TemplateResult {
    const active = this.chosenSeat === clientID;
    return html`
      <label
        class="flex items-center gap-3 p-3 rounded-xl border transition-colors ${claimed
          ? "opacity-40 cursor-not-allowed border-white/10 bg-white/5"
          : active
            ? "cursor-pointer border-malibu-blue bg-malibu-blue/10"
            : "cursor-pointer border-white/10 bg-white/5 hover:bg-white/10"}"
      >
        <input
          type="radio"
          name="server-nation"
          class="accent-malibu-blue"
          .disabled=${claimed}
          .checked=${active}
          @change=${() => {
            if (!claimed) this.chosenSeat = clientID as ClientID;
          }}
        />
        <span class="text-white">${username}</span>
        ${claimed
          ? html`<span class="ml-auto text-xs text-white/50"
              >${translateText("save_game.claimed")}</span
            >`
          : nothing}
      </label>
    `;
  }

  private renderPlayerRow(clientID: string, username: string): TemplateResult {
    const active = this.myClientID === clientID;
    return html`
      <label
        class="flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${active
          ? "border-malibu-blue bg-malibu-blue/10"
          : "border-white/10 bg-white/5 hover:bg-white/10"}"
      >
        <input
          type="radio"
          name="save-nation"
          class="accent-malibu-blue"
          .checked=${active}
          @change=${() => (this.myClientID = clientID as ClientID)}
        />
        <span class="text-white">${username}</span>
      </label>
    `;
  }
}
