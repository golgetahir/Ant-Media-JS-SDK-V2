import { icon } from "./icons.js";
import { dockMenu } from "./menu.js";
import { reportFailure } from "./session-element.js";

/**
 * Dock button for screen sharing through `client.media`: a menu of the two kinds of share while
 * not sharing, stop while sharing. Hidden where the browser cannot share a screen (phones).
 */
class AmsScreenButton extends HTMLElement {
  #client;
  // the stop that matches the share this button started
  #stop = "stopScreenShare";

  set client(client) {
    this.#client = client;
    for (const event of ["local_tracks_changed", "screen_share_stopped"]) client.on(event, () => this.paint());
    this.paint();
  }

  connectedCallback() {
    this.hidden = !navigator.mediaDevices?.getDisplayMedia;
    this.innerHTML = `
      <button class="ctl" type="button" aria-expanded="false">${icon("screen")}</button>
      <div class="menu" role="menu" hidden>
        <button type="button" role="menuitem" tabindex="-1" data-start="startScreenShare" data-stop="stopScreenShare">Share screen</button>
        <button type="button" role="menuitem" tabindex="-1" data-start="startScreenWithCameraOverlay" data-stop="stopScreenWithCameraOverlay">Share screen with camera</button>
      </div>`;
    const [button, menu] = this.children;
    const show = dockMenu(this, (item) => {
      this.#stop = item.dataset.stop;
      this.#run(item.dataset.start);
    });
    button.onclick = () => (this.#client.media.screenSharing ? this.#run(this.#stop) : show(menu.hidden));
    this.paint();
  }

  async #run(method) {
    try {
      await this.#client.media[method]();
    } catch (e) {
      // also when the user cancels the browser's picker
      reportFailure(this, `${method}()`, e);
    }
    this.paint();
  }

  paint() {
    const button = this.firstElementChild;
    if (!button || !this.#client) return;
    const sharing = this.#client.media.screenSharing;
    const label = sharing ? "Stop sharing" : "Share screen";
    button.classList.toggle("on", sharing);
    button.title = label;
    button.setAttribute("aria-label", label);
    if (sharing) button.removeAttribute("aria-haspopup");
    else button.setAttribute("aria-haspopup", "menu");
  }
}

customElements.define("ams-screen-button", AmsScreenButton);
