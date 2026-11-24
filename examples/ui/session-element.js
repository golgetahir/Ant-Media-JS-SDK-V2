// After these, session.state may differ. A start that fails or is cancelled only settles ready().
const STATE_EVENTS = [
  "publish_started",
  "play_started",
  "publish_finished",
  "play_finished",
  "reconnection_attempt_for_publisher",
  "reconnection_attempt_for_player",
  "reconnected",
];

/** Tell the page that `action` failed with `error`: a bubbling `ams-failure` event from `element`. */
export const reportFailure = (element, action, error) =>
  element.dispatchEvent(new CustomEvent("ams-failure", { bubbles: true, detail: { action, error } }));

// played sessions whose source stopped: play_finished heard, play_started not heard since
const waiting = new WeakSet();

/**
 * The samples' own state on top of `session.state`: the source of a played stream stopped and
 * the session, still active, waits for it to return. Kept by onStateChange().
 */
export const isWaiting = (session) => waiting.has(session) && session.state !== "ended";

/** Calls `fn` whenever `session.state` or isWaiting() may have changed; returns the function that stops it. */
export function onStateChange(session, fn) {
  let on = true;
  const offs = STATE_EVENTS.map((event) =>
    session.on(event, () => {
      if (event === "play_finished") waiting.add(session);
      if (event === "play_started") waiting.delete(session);
      fn();
    }),
  );
  session.ready().then(
    () => on && fn(),
    () => on && fn(),
  );
  return () => {
    on = false;
    offs.forEach((off) => off());
  };
}

/**
 * Base of the components that show one session, given through the `session` property (null for
 * none). A new session drops every listener of the old one.
 */
export class SessionElement extends HTMLElement {
  #session = null;
  #offs = [];

  get session() {
    return this.#session;
  }

  set session(session) {
    this.#offs.splice(0).forEach((off) => off());
    this.#session = session ?? null;
    if (session) this.#offs = [onStateChange(session, () => this.paint()), ...this.listen(session)];
    if (this.isConnected) this.paint();
  }

  disconnectedCallback() {
    this.session = null;
  }

  /** Subscribe to a new session; returns the functions that unsubscribe. */
  listen() {
    return [];
  }

  /** Repaint from `this.session` and its state. */
  paint() {}
}
