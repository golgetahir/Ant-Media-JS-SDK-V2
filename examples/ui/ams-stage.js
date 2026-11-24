import { icon } from "./icons.js";

/**
 * The video surface. `video` is its <video>; what the page puts inside (overlays, controls) stays
 * on top of it. setPlaceholder() covers the picture with a line of text and an optional button.
 * With the `remote` attribute it shows a received stream: whole, and with its sound.
 */
class AmsStage extends HTMLElement {
  connectedCallback() {
    if (this.video) return;
    const remote = this.hasAttribute("remote");
    this.insertAdjacentHTML(
      "afterbegin",
      `<video autoplay playsinline${remote ? "" : " muted"}></video>
      <div class="placeholder"><div>
        <span class="avatar">${icon(remote ? "live" : "user")}</span><p></p><button type="button" hidden></button>
      </div></div>`,
    );
    this.video = this.querySelector("video");
  }

  /**
   * Show `text` instead of the picture, with an optional `{ label, run, icon }` action; null shows
   * the picture. An action with an icon is the large round control above the text.
   */
  setPlaceholder(text, action = null) {
    const placeholder = this.querySelector(".placeholder");
    const [avatar, line, button] = placeholder.firstElementChild.children;
    const round = !!action?.icon;
    placeholder.hidden = text == null;
    line.textContent = text ?? "";
    avatar.hidden = round;
    button.hidden = !action;
    button.className = round ? "round" : "ghost";
    if (round) button.innerHTML = icon(action.icon);
    else button.textContent = action?.label ?? "";
    button.title = round ? action.label : "";
    if (round) button.setAttribute("aria-label", action.label);
    else button.removeAttribute("aria-label");
    button.onclick = action?.run ?? null;
  }
}

customElements.define("ams-stage", AmsStage);
