import { icon, mark, initial } from "./icons.js";
import { SessionElement, reportFailure } from "./session-element.js";

// a row: the avatar's letter and the name are text only, names come from other people
const row = (name, extra = "") => {
  const li = document.createElement("li");
  li.innerHTML = `<span class="initial"></span><span class="who"></span>${extra}`;
  li.children[0].textContent = initial(name);
  li.children[1].textContent = name;
  return li;
};

/**
 * Who is in the room, given the room's play session: you, then `people` (id → { name, micMuted,
 * cameraOff }), each with a pin that keeps them on a video slot. `pinned` is the id you pinned, kept
 * by the page: a pin click tells it with a bubbling `ams-pin` event, the id now pinned or "".
 */
class AmsPeople extends SessionElement {
  pinned = "";
  #people = new Map();
  // the last video_track_assignments: who is on which slot
  #assigned = [];

  set people(people) {
    this.#people = people;
    this.paint();
  }

  connectedCallback() {
    this.innerHTML = `<ul class="people" aria-label="People"></ul><div class="empty"><p></p></div>`;
    this.paint();
  }

  listen(room) {
    this.#assigned = [];
    return [
      room.on("video_track_assignments", ({ payload }) => {
        this.#assigned = payload;
        this.paint();
      }),
    ];
  }

  // one pin at a time: release the one pinned before, then pin on their own slot, else on the first
  async #pin(id) {
    const old = this.pinned;
    const slot = (who) => this.#assigned.find((a) => a.trackId === who);
    try {
      if (old && slot(old)) await this.session.assignVideoTrack(slot(old).videoLabel, old, false);
      if (id !== old) await this.session.assignVideoTrack((slot(id) ?? this.#assigned[0]).videoLabel, id, true);
      this.dispatchEvent(new CustomEvent("ams-pin", { bubbles: true, detail: id === old ? "" : id }));
    } catch (e) {
      reportFailure(this, "assignVideoTrack()", e);
    }
  }

  paint() {
    const [list, empty] = this.children;
    if (!list) return;
    const joined = !!this.session && this.session.state !== "ended";
    // the list is drawn again: keep the keyboard on the pin it was on
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    list.replaceChildren();
    if (joined) list.append(row("You"));
    for (const [id, { name, micMuted, cameraOff }] of joined ? this.#people : []) {
      const pinned = id === this.pinned;
      const marks = (micMuted ? mark("mic-off", "Microphone off") : "") + (cameraOff ? mark("cam-off", "Camera off") : "");
      const li = row(name, `${marks}<button class="mini pin" type="button">${icon("pin")}</button>`);
      const pin = li.querySelector("button");
      pin.dataset.id = id;
      pin.title = pinned ? "Unpin" : "Pin";
      pin.setAttribute("aria-label", `Pin ${name}`);
      pin.setAttribute("aria-pressed", pinned);
      pin.disabled = !this.#assigned.length;
      pin.onclick = () => this.#pin(id);
      list.append(li);
      if (id === focused) pin.focus();
    }
    empty.hidden = joined && this.#people.size > 0;
    empty.firstElementChild.textContent = joined ? "No one else is here yet. Send the invite link." : "Join the room to see who is here";
  }
}

customElements.define("ams-people", AmsPeople);
