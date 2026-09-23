import { html, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { GameCheckpoint } from "../core/Checkpoint";
import { decodeCheckpointWire } from "../core/CheckpointCodec";
import type { ClientID, SavedGame, SavedGameMeta } from "../core/Schemas";
import {
  deleteSavedLobby,
  listSavedLobbies,
  resumeSavedLobby,
  type SavedLobbyLookupError,
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

// The inline lobby screens SavesModal hands off to. They are declared here as a
// structural type (not imported classes) to avoid a runtime import cycle:
// both lobby modals import types from Main, which imports SavesModal.
interface LobbyScreenElement extends HTMLElement {
  open(args?: Record<string, unknown>): void;
}

@customElement("saves-modal")
export class SavesModal extends BaseModal {
  protected routerName = "load-game";

  // Local (browser) saves.
  @state() private saves: SavedGameMeta[] | null = null;
  @state() private selected: SavedGame | null = null;

  // Server-hosted saves the host can resume as a private lobby.
  @state() private serverSaves: SavedLobbySummary[] | null = null;
  // Per-worker outcome of the last server listing, shown when it came back
  // empty so an auth/routing failure is not mistaken for "no saves".
  @state() private serverLookup: {
    workers: number;
    errors: SavedLobbyLookupError[];
  } | null = null;
  @state() private myClientID: ClientID | null = null;
  @state() private error = "";

  protected renderHeaderSlot() {
    const onBack = this.selected
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
    this.serverLookup = null;
    this.myClientID = null;
    this.error = "";
    void this.refresh();
  }

  protected onClose(): void {
    this.selected = null;
    this.serverLookup = null;
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
      const result = await listSavedLobbies();
      this.serverSaves = result.saves;
      this.serverLookup = { workers: result.workers, errors: result.errors };
      if (result.saves.length === 0) {
        console.info(
          `No resumable lobbies: ${result.workers} worker(s), ` +
            `${result.errors.length} error(s)`,
        );
      }
    } catch (error) {
      console.error("Failed to list server saves", error);
      this.serverSaves = [];
      this.serverLookup = null;
    }
  }

  private clearSelection(): void {
    this.selected = null;
    this.myClientID = null;
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

  private async resumeLocal(): Promise<void> {
    const save = this.selected;
    const clientID = this.myClientID;
    if (!save || !clientID || !commitMatches(save.gitCommit)) {
      return;
    }
    // The worker encoded the checkpoint, so what is stored is a wire string
    // (tagged-JSON or `gz:` gzip). Decode it once here — off the per-autosave
    // path — and hand both the object (for the worker) and the raw string (for
    // the resumed game's own autosaves) to the game.
    let checkpoint: GameCheckpoint | undefined;
    let checkpointWire: string | undefined;
    if (typeof save.checkpoint === "string") {
      checkpoint = await decodeCheckpointWire(save.checkpoint);
      if (checkpoint === undefined) {
        console.warn("dropping unreadable local checkpoint");
      } else {
        checkpointWire = save.checkpoint;
      }
    }
    this.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: save.startInfo.gameID,
          resume: {
            startInfo: save.startInfo,
            turns: save.turns,
            myClientID: clientID,
            checkpoint,
            checkpointWire,
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

  // Reopen a server save as a private lobby. The save is rebuilt on its worker
  // first, then the private-lobby screen is handed the game: a not-yet-started
  // save reopens the host lobby (config, roster, share link, Start), while a
  // running save reopens the join lobby, where players claim a saved nation and
  // wait out the resume countdown together.
  private async selectServerSave(meta: SavedLobbySummary): Promise<void> {
    if (!commitMatches(meta.gitCommit)) {
      this.error = translateText("save_game.version_mismatch");
      return;
    }
    try {
      await resumeSavedLobby(meta.gameID);
    } catch (error) {
      console.error("Failed to resume saved lobby", error);
      this.error = translateText("save_game.resume_failed");
      return;
    }
    this.close();
    if (meta.stage === "lobby") {
      (
        document.querySelector("host-lobby-modal") as LobbyScreenElement | null
      )?.open({ existingLobbyId: meta.gameID });
    } else {
      (
        document.querySelector("join-lobby-modal") as LobbyScreenElement | null
      )?.open({ lobbyId: meta.gameID });
    }
  }

  private async removeServerSave(
    meta: SavedLobbySummary,
    event: Event,
  ): Promise<void> {
    event.stopPropagation();
    try {
      await deleteSavedLobby(meta.gameID);
      await this.refresh();
    } catch (error) {
      console.error("Failed to delete server save", error);
    }
  }

  // --- Render ------------------------------------------------------------

  protected renderBody(): TemplateResult {
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
              </p>
              ${this.renderServerDiagnostic()}`
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

  private renderServerDiagnostic(): TemplateResult | typeof nothing {
    const lookup = this.serverLookup;
    if (lookup === null || lookup.errors.length === 0) {
      return nothing;
    }
    const details = lookup.errors
      .map((e) =>
        e.status !== undefined
          ? translateText("save_game.server_error_http", {
              worker: e.worker,
              status: e.status,
            })
          : translateText("save_game.server_error_unreachable", {
              worker: e.worker,
            }),
      )
      .join(" · ");
    return html`<p class="text-xs text-red-300">
      ${translateText("save_game.server_diagnostic", { details })}
    </p>`;
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
