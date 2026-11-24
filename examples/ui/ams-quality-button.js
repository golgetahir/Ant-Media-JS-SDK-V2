import { icon } from "./icons.js";
import { dockMenu } from "./menu.js";
import { SessionElement, isWaiting, reportFailure } from "./session-element.js";

const name = (height) => (height ? `${height}p` : "Automatic");

/**
 * Dock button with a menu of the played stream's renditions and Automatic, through `client`
 * and the session. The renditions are asked of the server each time it reports the stream
 * playing; each (re)start plays automatic. Usable while the stream is live.
 */
class AmsQualityButton extends SessionElement {
  client = null;
  #height = 0;
  #show;

  connectedCallback() {
    this.innerHTML = `
      <button class="ctl" type="button" aria-haspopup="menu" aria-expanded="false">${icon("quality")}</button>
      <div class="menu" role="menu" aria-label="Quality" hidden></div>`;
    this.#show = dockMenu(this, (item) => this.#force(Number(item.dataset.height)));
    this.firstElementChild.onclick = () => this.#show(this.lastElementChild.hidden);
    this.#fill([]);
  }

  listen(session) {
    this.#fill([]);
    return [session.on("play_started", () => this.#load(session))];
  }

  async #load(session) {
    try {
      const { streamInfo } = await this.client.getStreamInfo(session.streamId);
      if (session === this.session) this.#fill(streamInfo.map((r) => r.streamHeight));
    } catch (e) {
      reportFailure(this, "getStreamInfo()", e);
    }
  }

  async #force(height) {
    try {
      await this.session.forceStreamQuality(height);
      this.#height = height;
    } catch (e) {
      reportFailure(this, "forceStreamQuality()", e);
    }
    this.paint();
  }

  // Automatic, then each height once, highest first
  #fill(heights) {
    this.#height = 0;
    const items = [0, ...new Set(heights.sort((a, b) => b - a))].map((height) => {
      const item = document.createElement("button");
      item.type = "button";
      item.tabIndex = -1;
      item.setAttribute("role", "menuitemradio");
      item.dataset.height = height;
      item.innerHTML = `<span></span>${icon("check")}`;
      item.firstChild.textContent = name(height);
      return item;
    });
    this.lastElementChild.replaceChildren(...items);
    this.paint();
  }

  paint() {
    const [button, menu] = this.children;
    if (!menu) return;
    const label = `Quality: ${name(this.#height)}`;
    button.disabled = this.session?.state !== "live" || isWaiting(this.session);
    if (button.disabled) this.#show(false);
    button.title = label;
    button.setAttribute("aria-label", label);
    for (const item of menu.children) item.setAttribute("aria-checked", Number(item.dataset.height) === this.#height);
  }
}

customElements.define("ams-quality-button", AmsQualityButton);
