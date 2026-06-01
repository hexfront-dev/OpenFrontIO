import { html, LitElement, TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";
import { NavNotificationsController } from "./NavNotificationsController";

@customElement("mobile-nav-bar")
export class MobileNavBar extends LitElement {
  private _notifications = new NavNotificationsController(this);

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("showPage", this._onShowPage);
    const current = window.currentPageId;
    if (current) {
      this.updateComplete.then(() => {
        this._updateActiveState(current);
      });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("showPage", this._onShowPage);
  }

  private _onShowPage = (e: Event) => {
    const pageId = (e as CustomEvent<string>).detail;
    this._updateActiveState(pageId);
  };

  private _updateActiveState(pageId: string) {
    this.querySelectorAll(".nav-menu-item").forEach((el) => {
      const inner = el.querySelector("button");
      if ((el as HTMLElement).dataset.page === pageId) {
        el.classList.add("active");
        inner?.classList.add("active");
      } else {
        el.classList.remove("active");
        inner?.classList.remove("active");
      }
    });
  }

  private _renderDot(color: string): TemplateResult {
    return html`<span class="absolute top-0 right-0 w-2 h-2 ${color} rounded-full"></span>`;
  }

  render() {
    window.currentPageId ??= "page-play";
    const currentPage = window.currentPageId;

    return html`
      <nav class="mobile-nav-bar">
        <div class="nav-menu-item ${currentPage === "page-play" ? "active" : ""}" data-page="page-play">
          <button class="nav-menu-button ${currentPage === "page-play" ? "active" : ""}" data-target="page-play">
            <img src="${assetUrl("icons/play.svg")}" alt="Play" class="nav-icon" />
          </button>
        </div>
        <div class="nav-menu-item relative ${currentPage === "page-news" ? "active" : ""}" data-page="page-news">
          <button class="nav-menu-button ${currentPage === "page-news" ? "active" : ""}" data-target="page-news">
            <img src="${assetUrl("icons/news.svg")}" alt="News" class="nav-icon" />
          </button>
          ${this._notifications.showNewsDot() ? this._renderDot("bg-red-500") : ""}
        </div>
        <div class="nav-menu-item relative ${currentPage === "page-help" ? "active" : ""}" data-page="page-help">
          <button class="nav-menu-button ${currentPage === "page-help" ? "active" : ""}" data-target="page-help">
            <img src="${assetUrl("icons/help.svg")}" alt="Help" class="nav-icon" />
          </button>
          ${this._notifications.showHelpDot() ? this._renderDot("bg-yellow-400") : ""}
        </div>
      </nav>
    `;
  }
}
