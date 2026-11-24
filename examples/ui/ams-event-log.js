import { SessionElement } from "./session-element.js";

// the events shown, with what each adds to its line
const events = {
  publish_started: null,
  play_started: null,
  publish_finished: null,
  play_finished: null,
  reconnection_attempt_for_publisher: null,
  reconnection_attempt_for_player: null,
  reconnected: null,
  data_channel_opened: null,
  data_channel_closed: null,
  ice_connection_state_changed: (p) => p.state,
  error: (p) => p.error,
};
const ROWS = 4;

/** The last few events of the session, and lines the page adds with add(); a repeated line counts up. */
class AmsEventLog extends SessionElement {
  #empty = true;

  connectedCallback() {
    this.innerHTML = `<div class="log" role="log"><div><time>--:--:--</time><span>Events from the session appear here</span></div></div>`;
  }

  listen(session) {
    return Object.entries(events).map(([name, note]) => session.on(name, (p) => this.add(name, note?.(p))));
  }

  /** Append a line, or count the last one up when it is the same; text only, never HTML. */
  add(name, note = "") {
    const log = this.firstElementChild;
    if (this.#empty) log.replaceChildren();
    this.#empty = false;
    const line = `${name}\n${note}`;
    let row = log.lastElementChild;
    if (row?.dataset.line === line) {
      row.dataset.count++;
    } else {
      row = document.createElement("div");
      row.innerHTML = "<time></time><b></b><span></span><small></small>";
      row.dataset.line = line;
      row.dataset.count = 1;
      row.children[1].textContent = name;
      row.children[2].textContent = note;
      log.append(row);
    }
    const [time, , , count] = row.children;
    time.textContent = new Date().toLocaleTimeString([], { hour12: false });
    count.textContent = row.dataset.count > 1 ? `×${row.dataset.count}` : "";
    while (log.children.length > ROWS) log.firstElementChild.remove();
  }
}

customElements.define("ams-event-log", AmsEventLog);
