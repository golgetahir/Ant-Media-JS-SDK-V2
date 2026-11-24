import { icon } from "./icons.js";
import { reportFailure } from "./session-element.js";

/**
 * Dock button that shows the stage it sits on full screen, and leaves it; its state follows the
 * browser, Escape included. Hidden where the browser cannot (iPhone).
 */
class AmsFullscreenButton extends HTMLElement {
  #paint = () => this.paint();

  connectedCallback() {
    this.hidden = !document.fullscreenEnabled;
    this.innerHTML = `<button class="ctl" type="button"></button>`;
    this.firstElementChild.onclick = async () => {
      const [target, method] = document.fullscreenElement
        ? [document, "exitFullscreen"]
        : [this.closest("ams-stage"), "requestFullscreen"];
      try {
        await target[method]();
      } catch (e) {
        reportFailure(this, `${method}()`, e);
      }
    };
    document.addEventListener("fullscreenchange", this.#paint);
    this.paint();
  }

  disconnectedCallback() {
    document.removeEventListener("fullscreenchange", this.#paint);
  }

  paint() {
    const on = !!document.fullscreenElement;
    const label = on ? "Exit full screen" : "Full screen";
    const button = this.firstElementChild;
    button.innerHTML = icon(on ? "shrink" : "expand");
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

customElements.define("ams-fullscreen-button", AmsFullscreenButton);
