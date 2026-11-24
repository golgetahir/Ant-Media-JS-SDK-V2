import { icon } from "./icons.js";

/**
 * Dock button that mutes and unmutes `video`, showing its real state. Each new picture starts
 * with sound; where the browser refuses that without a click on the page, it starts muted and
 * the button invites unmuting.
 */
class AmsSoundButton extends HTMLElement {
  #video;
  #invite = false;

  set video(video) {
    this.#video = video;
    video.addEventListener("volumechange", () => this.paint());
    video.addEventListener("loadedmetadata", async () => {
      try {
        await video.play();
      } catch (e) {
        // a newer picture interrupting this one is no refusal
        if (e.name !== "NotAllowedError") return;
        this.#invite = video.muted = true;
        video.play().catch(() => {});
      }
    });
    this.paint();
  }

  connectedCallback() {
    this.innerHTML = `<button class="ctl" type="button"></button>`;
    this.firstElementChild.onclick = () => (this.#video.muted = !this.#video.muted);
    this.paint();
  }

  paint() {
    const button = this.firstElementChild;
    if (!button || !this.#video) return;
    const { muted } = this.#video;
    this.#invite &&= muted;
    const label = muted ? "Unmute" : "Mute";
    button.classList.toggle("off", muted);
    button.classList.toggle("invite", this.#invite);
    button.innerHTML = icon(muted ? "sound-off" : "sound") + (this.#invite ? "<span>Tap to unmute</span>" : "");
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

customElements.define("ams-sound-button", AmsSoundButton);
