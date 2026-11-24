import { getWebSocketURL } from "../dist/index.js";

// Server for all example pages: ?websocketURL=... wins. Otherwise pages served from the repo
// (npm run examples, under /examples/) use a local Ant Media Server, and pages deployed into
// a server app (redeploy.sh) use that app.
export const websocketURL =
  new URLSearchParams(location.search).get("websocketURL") ||
  (location.pathname.startsWith("/examples/")
    ? "ws://localhost:5080/LiveApp/websocket"
    : getWebSocketURL(location));

/**
 * True for a finished event the session outlives: its source stopped and recovery waits for it.
 * Reports that with `say`; false when the event ended the session.
 */
export function sourceStopped(session, say) {
  if (session.state === "ended") return false;
  say("source stopped, waiting for it to return");
  return true;
}

/** Link to an example page for a stream, on the same server. */
export const streamLink = (page, id) => page + "?" + new URLSearchParams({ id, websocketURL });
