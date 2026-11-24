import "./ams-stage.js";
import { icon, mark, initial } from "./icons.js";
import { SessionElement, reportFailure } from "./session-element.js";

/**
 * A room's videos, given the room's play session: your own tile, `own`, always (an <ams-stage>: its
 * `video` and setPlaceholder() are your camera preview), and a tile for each video slot the server
 * fills. What the page puts inside (overlays, controls) stays on top. `people` names the others
 * (id → { name, micMuted, cameraOff }); `myId` is your own publish id; the server sends `perPage`
 * videos and the pager moves through everyone.
 */
class AmsTiles extends SessionElement {
  myId = "";
  #people = new Map();
  #perPage = 6;
  #page = 0;
  // video label → its tile, audio label → its <audio>; the last video_track_assignments
  #slots = new Map();
  #sounds = new Map();
  #assigned = [];

  connectedCallback() {
    if (this.own) return;
    this.insertAdjacentHTML(
      "afterbegin",
      `<div class="tiles"><ams-stage class="tile"><span class="glass name">You</span></ams-stage></div>
      <div class="overlay tr glass pager" hidden>
        <button type="button" aria-label="Previous page" title="Previous page">${icon("prev")}</button><span></span>
        <button type="button" aria-label="Next page" title="Next page">${icon("next")}</button>
      </div>`,
    );
    this.own = this.querySelector("ams-stage");
    const [prev, , next] = this.querySelector(".pager").children;
    prev.onclick = () => this.#turn(this.#page - 1);
    next.onclick = () => this.#turn(this.#page + 1);
    this.paint();
  }

  get session() {
    return super.session;
  }

  set session(session) {
    // a new room, or none: the old room's videos and sounds go
    for (const media of [...this.#slots.values(), ...this.#sounds.values()]) media.remove();
    this.#slots.clear();
    this.#sounds.clear();
    this.#assigned = [];
    super.session = session;
  }

  set people(people) {
    this.#people = people;
    // people left: stay on a page that exists
    if (this.#page > this.#last()) this.#turn(this.#last());
    this.paint();
  }

  set perPage(n) {
    this.#perPage = n;
    this.#turn(Math.min(this.#page, this.#last()));
  }

  listen(room) {
    return [
      room.on("newTrackAvailable", ({ track, trackId }) => {
        // a slot label, videoTrack0… or audioTrack0…, after a 7-character prefix
        const label = trackId.substring(7);
        if (label === room.streamId || label === this.myId) return;
        // after a reconnect the same labels come again, with new tracks
        const media = track.kind === "video" ? this.#tile(label).querySelector("video") : this.#sound(label);
        media.srcObject = new MediaStream([track]);
      }),
      room.on("video_track_assignments", ({ payload }) => {
        this.#assigned = payload;
        this.paint();
      }),
      // each start, a reconnect's too, is a new viewer for the server
      room.on("play_started", () => this.#window()),
    ];
  }

  #last() {
    return Math.max(0, Math.ceil(this.#people.size / this.#perPage) - 1);
  }

  #turn(page) {
    this.#page = page;
    this.#window();
    this.paint();
  }

  // how many videos the server sends, and from which participant on
  async #window() {
    const room = this.session;
    if (room?.state !== "live" && room?.state !== "reconnecting") return;
    try {
      await room.setMaxVideoTrackCount(this.#perPage);
      await room.updateVideoTrackAssignments(this.#page * this.#perPage, this.#perPage);
    } catch (e) {
      reportFailure(this, "video paging", e);
    }
  }

  #tile(label) {
    if (!this.#slots.has(label)) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.innerHTML = `<video autoplay playsinline muted></video><span class="initial"></span><span class="glass name"></span>`;
      this.querySelector(".tiles").append(tile);
      this.#slots.set(label, tile);
      this.paint();
    }
    return this.#slots.get(label);
  }

  #sound(label) {
    if (!this.#sounds.has(label)) {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      this.#sounds.set(label, this.appendChild(audio));
    }
    return this.#sounds.get(label);
  }

  paint() {
    const grid = this.querySelector(".tiles");
    if (!grid) return;
    let count = 1;
    for (const [label, tile] of this.#slots) {
      // no tile for a free slot, or one showing yourself
      const slot = this.#assigned.find((a) => a.videoLabel === label);
      tile.hidden = !slot?.trackId || slot.trackId === this.myId;
      tile.classList.toggle("pinned", !tile.hidden && slot.reserved);
      if (tile.hidden) continue;
      count++;
      const { name = slot.trackId, micMuted, cameraOff } = this.#people.get(slot.trackId) ?? {};
      tile.classList.toggle("off", !!cameraOff);
      tile.querySelector(".initial").textContent = initial(name);
      const chip = tile.querySelector(".name");
      chip.innerHTML = `${slot.reserved ? mark("pin", "Pinned") : ""}<span></span>${micMuted ? mark("mic-off", "Microphone off") : ""}`;
      chip.querySelector("span").textContent = name;
    }
    grid.style.setProperty("--cols", Math.ceil(Math.sqrt(count)));
    grid.classList.toggle("solo", count === 1);

    const pager = this.querySelector(".pager");
    const [prev, text, next] = pager.children;
    pager.hidden = !this.session || this.#people.size <= this.#perPage;
    text.textContent = `${this.#page + 1} / ${this.#last() + 1}`;
    prev.disabled = this.#page === 0;
    next.disabled = this.#page === this.#last();
  }
}

customElements.define("ams-tiles", AmsTiles);
