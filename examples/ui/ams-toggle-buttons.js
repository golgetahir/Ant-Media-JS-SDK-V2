import { icon } from "./icons.js";
import { reportFailure } from "./session-element.js";

/** A dock button that switches one device through `client.media` and shows its real state. */
const toggleButton = ({ name, isOff, next, labels, events }) =>
  class extends HTMLElement {
    #client;

    set client(client) {
      this.#client = client;
      for (const event of events) client.on(event, () => this.paint());
      this.paint();
    }

    connectedCallback() {
      this.innerHTML = `<button class="ctl" type="button"></button>`;
      this.firstElementChild.onclick = async () => {
        const method = next(this.#client.media);
        try {
          await this.#client.media[method]();
        } catch (e) {
          reportFailure(this, `${method}()`, e);
        }
        this.paint();
      };
      this.paint();
    }

    paint() {
      const button = this.firstElementChild;
      if (!button || !this.#client) return;
      const off = isOff(this.#client.media);
      button.classList.toggle("off", off);
      button.innerHTML = icon(off ? `${name}-off` : name);
      button.title = labels[+off];
      button.setAttribute("aria-label", labels[+off]);
    }
  };

customElements.define(
  "ams-mic-button",
  toggleButton({
    name: "mic",
    isOff: (media) => media.micMuted,
    next: (media) => (media.micMuted ? "unmuteLocalMic" : "muteLocalMic"),
    labels: ["Mute microphone", "Unmute microphone"],
    events: ["local_track_paused", "local_track_resumed"],
  }),
);

customElements.define(
  "ams-camera-button",
  toggleButton({
    name: "cam",
    isOff: (media) => media.cameraOff,
    next: (media) => (media.cameraOff ? "turnOnLocalCamera" : "turnOffLocalCamera"),
    labels: ["Turn camera off", "Turn camera on"],
    events: ["local_tracks_changed"],
  }),
);
