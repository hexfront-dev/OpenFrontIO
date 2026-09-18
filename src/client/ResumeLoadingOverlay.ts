import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "./Utils";

// Full-screen blocking overlay shown while a resumed save fast-forwards its
// history off-screen. The worker replays the saved turns as fast as it can;
// this hides that catch-up so the player only ever sees the state they saved
// at, not an animated re-run of the whole game.
@customElement("resume-loading-overlay")
export class ResumeLoadingOverlay extends LitElement {
  @state()
  private progress = 0;

  // B1: when a render preview has already painted the saved map, the overlay
  // stops hiding the canvas and shrinks to a progress pill. It still covers the
  // screen invisibly so input cannot reach the not-yet-live game.
  @state()
  private preview = false;

  createRenderRoot() {
    return this;
  }

  public setProgress(percent: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (clamped === this.progress) return;
    this.progress = clamped;
    this.requestUpdate();
  }

  public setPreviewMode(on: boolean): void {
    if (this.preview === on) return;
    this.preview = on;
    this.requestUpdate();
  }

  render() {
    const progress = this.progress;
    if (this.preview) {
      return html`
        <div class="fixed inset-0 z-[10000] flex items-end justify-center">
          <div
            class="mb-6 flex items-center gap-3 rounded-full bg-black/70 px-4 py-2 text-white text-sm backdrop-blur-sm"
          >
            <div
              class="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"
            ></div>
            <span>${translateText("save_game.catching_up")}</span>
            <span class="text-white/60">${progress}%</span>
          </div>
        </div>
      `;
    }
    return html`
      <div
        class="fixed inset-0 z-[10000] flex flex-col items-center justify-center gap-5 bg-black/80 backdrop-blur-sm text-white"
      >
        <div
          class="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin"
        ></div>
        <p class="text-lg font-medium tracking-wide">
          ${translateText("save_game.catching_up")}
        </p>
        <div class="w-64 h-2 rounded-full bg-white/10 overflow-hidden">
          <div
            class="h-full bg-malibu-blue transition-all duration-100"
            style="width: ${progress}%"
          ></div>
        </div>
        <p class="text-sm text-white/60">${progress}%</p>
      </div>
    `;
  }
}
