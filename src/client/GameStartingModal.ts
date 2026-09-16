import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  calculateServerTimeOffset,
  getSecondsUntilServerTimestamp,
  renderDuration,
  translateText,
} from "./Utils";

@customElement("game-starting-modal")
export class GameStartingModal extends LitElement {
  @state()
  isVisible = false;

  // A resumed save waits out a short start countdown before play continues so
  // players can pick a nation. Null when there is no countdown to show.
  @state()
  private countdownSeconds: number | null = null;
  private countdownStartsAt: number | null = null;
  private serverTimeOffset = 0;
  private countdownTimer: number | null = null;

  createRenderRoot() {
    return this;
  }

  // Deadline is the server wall clock (epoch ms); serverTime is the server's
  // "now" at send time, used to correct client/server clock skew.
  public setCountdown(startsAt?: number, serverTime?: number): void {
    this.countdownStartsAt = startsAt ?? null;
    this.serverTimeOffset =
      serverTime !== undefined ? calculateServerTimeOffset(serverTime) : 0;
    if (this.countdownStartsAt === null) {
      this.clearCountdownTimer();
      this.countdownSeconds = null;
      this.requestUpdate();
      return;
    }
    this.updateCountdown();
    this.countdownTimer ??= window.setInterval(
      () => this.updateCountdown(),
      1000,
    );
  }

  private updateCountdown(): void {
    if (this.countdownStartsAt === null) {
      return;
    }
    const seconds = getSecondsUntilServerTimestamp(
      this.countdownStartsAt,
      this.serverTimeOffset,
    );
    if (seconds <= 0) {
      // Deadline already passed (e.g. the normal prestart->start window) or
      // just elapsed: stop showing a countdown rather than "0:00".
      this.countdownSeconds = null;
      this.clearCountdownTimer();
    } else {
      this.countdownSeconds = seconds;
    }
    this.requestUpdate();
  }

  private clearCountdownTimer(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.clearCountdownTimer();
  }

  render() {
    const isVisible = this.isVisible;
    return html`
      <div
        class="fixed inset-0 bg-black/30 backdrop-blur-[4px] z-[9998] transition-all duration-300 ${isVisible
          ? "opacity-100 visible"
          : "opacity-0 invisible"}"
      ></div>
      <div
        class="fixed top-1/2 left-1/2 bg-zinc-900/90 backdrop-blur-md border border-white/10 p-6 rounded-2xl z-[9999] shadow-2xl text-white w-[400px] text-center transition-all duration-300 -translate-x-1/2 ${isVisible
          ? "opacity-100 visible -translate-y-1/2"
          : "opacity-0 invisible -translate-y-[48%]"}"
      >
        <div
          class="text-base font-medium tracking-wider uppercase text-white/40 mb-3"
        >
          ${translateText("main.copyright")}
        </div>
        <a
          href="https://github.com/openfrontio/OpenFrontIO/blob/main/CREDITS.md"
          target="_blank"
          rel="noopener noreferrer"
          class="block mb-4 text-lg font-medium tracking-wider uppercase text-malibu-blue no-underline transition-colors duration-200 hover:text-aquarius"
          >${translateText("game_starting_modal.credits")}</a
        >
        <p class="text-base text-white/40 mb-4">
          ${translateText("game_starting_modal.code_license")}
        </p>
        <p
          class="text-xl font-medium tracking-wider text-white bg-white/5 border border-white/10 px-4 py-3 rounded-xl"
        >
          ${translateText("game_starting_modal.title")}
        </p>
        ${this.countdownSeconds !== null
          ? html`<p
              class="mt-4 text-lg font-medium tracking-wider text-malibu-blue"
            >
              ${translateText("public_lobby.starting_in", {
                time: renderDuration(this.countdownSeconds),
              })}
            </p>`
          : nothing}
      </div>
    `;
  }

  show() {
    this.isVisible = true;
    this.requestUpdate();
  }

  hide() {
    this.isVisible = false;
    // The countdown belongs to this start; clear it so it never leaks into a
    // later game's loading screen.
    this.setCountdown(undefined);
    this.requestUpdate();
  }
}
