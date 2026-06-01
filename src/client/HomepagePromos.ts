import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";

@customElement("homepage-promos")
export class HomepagePromos extends LitElement {
  createRenderRoot() {
    return this;
  }

  public show(): void {}
  public close(): void {}
  public loadBottomRail(): void {}
  public destroyBottomRail(): void {}

  render() {
    return html``;
  }
}
