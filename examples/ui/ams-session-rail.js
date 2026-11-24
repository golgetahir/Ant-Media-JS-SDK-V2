import { icon } from "./icons.js";
import { SessionElement } from "./session-element.js";

const states = ["starting", "live", "reconnecting", "ended"];

/** The session's states in order, its current one highlighted. */
class AmsSessionRail extends SessionElement {
  connectedCallback() {
    const steps = states.map((s) => `<span class="step" data-state="${s}">${s}</span>`);
    this.innerHTML = `<div class="rail"><span>Session</span>${steps.join(icon("right"))}</div>`;
    this.paint();
  }

  paint() {
    for (const step of this.querySelectorAll(".step")) {
      step.setAttribute("aria-current", step.dataset.state === this.session?.state ? "step" : "false");
    }
  }
}

customElements.define("ams-session-rail", AmsSessionRail);
