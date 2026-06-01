import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("google-ad")
export class GoogleAdElement extends LitElement {
  @property({ type: String }) adClient = "";
  @property({ type: String }) adSlot = "";
  @property({ type: String }) adFormat = "auto";
  @property({ type: Boolean }) fullWidthResponsive = true;
  @property({ type: String }) adTest = "off";

  createRenderRoot() {
    return this;
  }

  render() {
    return html``;
  }
}

export default GoogleAdElement;
