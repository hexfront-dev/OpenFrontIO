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

  createRenderRoot() {
    return this;
  }

  public setProgress(percent: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (clamped === this.progress) return;
    this.progress = clamped;
    this.requestUpdate();
  }

  render() {
    const progress = this.progress;
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
