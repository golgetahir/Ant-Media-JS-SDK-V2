import { SessionElement, isWaiting } from "./session-element.js";

const labels = { starting: "Starting…", reconnecting: "Reconnecting…", waiting: "Waiting for the stream" };
const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** The session's state on the video: Ready, Starting…, LIVE with its running time, Reconnecting…, Waiting. */
class AmsStatePill extends SessionElement {
  #since = 0;
  #timer;

  connectedCallback() {
    this.innerHTML = `<span class="glass state"><i></i><span></span></span>`;
    this.paint();
  }

  listen() {
    this.#since = 0;
    return [];
  }

  paint() {
    // an ended session leaves the page ready for the next one
    const state = isWaiting(this.session) ? "waiting" : this.session?.state === "ended" ? undefined : this.session?.state;
    const pill = this.firstElementChild;
    const text = pill.lastElementChild;
    pill.className = `glass state ${state ?? ""}`;
    clearInterval(this.#timer);
    if (state !== "live") {
      text.textContent = labels[state] ?? "Ready";
      return;
    }
    this.#since ||= Date.now();
    const tick = () => (text.textContent = `LIVE ${mmss(Date.now() - this.#since)}`);
    tick();
    this.#timer = setInterval(tick, 1000);
  }
}

customElements.define("ams-state-pill", AmsStatePill);
