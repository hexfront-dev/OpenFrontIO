import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";
import { NavNotificationsController } from "./NavNotificationsController";

@customElement("desktop-nav-bar")
export class DesktopNavBar extends LitElement {
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
      if ((el as HTMLElement).dataset.page === pageId) {
        el.classList.add("active");
      } else {
        el.classList.remove("active");
      }
    });
  }

  render() {
    window.currentPageId ??= "page-play";
    const currentPage = window.currentPageId;

    return html`
      <nav class="desktop-nav-bar">
        <div class="nav-menu-item ${currentPage === "page-play" ? "active" : ""}" data-page="page-play">
          <button class="nav-menu-button" data-target="page-play">
            <img src="${assetUrl("icons/play.svg")}" alt="Play" class="nav-icon" />
          </button>
        </div>
        <div class="nav-menu-item relative ${currentPage === "page-news" ? "active" : ""}" data-page="page-news">
          <button class="nav-menu-button" data-target="page-news">
            <img src="${assetUrl("icons/news.svg")}" alt="News" class="nav-icon" />
          </button>
          ${this._notifications.showNewsDot() ? html`<span class="notification-dot"></span>` : ""}
        </div>
        <div class="nav-menu-item relative ${currentPage === "page-help" ? "active" : ""}" data-page="page-help">
          <button class="nav-menu-button" data-target="page-help">
            <img src="${assetUrl("icons/help.svg")}" alt="Help" class="nav-icon" />
          </button>
          ${this._notifications.showHelpDot() ? html`<span class="notification-dot"></span>` : ""}
        </div>
      </nav>
    `;
  }
}
