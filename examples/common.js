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

// plain words for the codes the camera, a start or an action fail with
const problems = {
  NotAllowedError: "Permission was denied",
  NotFoundError: "No camera or microphone was found",
  NotReadableError: "The camera or microphone is in use by another app",
  OverconstrainedError: "The camera cannot give the requested format",
  WebSocketNotConnected: "The server could not be reached",
  timeout: "The server did not confirm the stream in time",
  unauthorized_access: "The server refused the token",
  no_stream_exist: "The stream is not live",
  streamIdInUse: "This stream ID is already in use",
  session_not_live: "The stream is not live yet",
  data_channel_not_available: "The data channel is not open",
  file_too_large: "Files over 64 MB cannot be sent",
};
export const explain = (code, fallback) => `${problems[code] ?? fallback} (${code})`;

/**
 * The camera preview on `stage` (its `video` and setPlaceholder()): preview() opens the camera,
 * showPicture() shows the picture, mirrored, or says why there is none, and runs `shown` after.
 * The picture follows the local tracks.
 */
export function cameraPreview(client, stage, shown = () => {}) {
  async function preview() {
    stage.setPlaceholder("Opening your camera…");
    try {
      await client.media.initLocalStream();
      showPicture();
    } catch (e) {
      stage.setPlaceholder(explain(e.name, "The camera could not be opened"), { label: "Retry", run: preview });
    }
  }
  function showPicture() {
    const { cameraOff, screenSharing } = client.media;
    // without a stream the placeholder keeps saying why
    if (!client.media.getLocalStream()) return;
    stage.setPlaceholder(cameraOff && !screenSharing ? "Camera is off" : null);
    stage.video.classList.toggle("mirror", !screenSharing);
    shown();
  }
  client.on("local_tracks_changed", showPicture);
  return { preview, showPicture };
}

// an SDKError's code, else the browser error's name (a DOMException's own code is a number)
export const codeOf = (error) => (typeof error.code === "string" ? error.code : error.name);

/** Failures in `log`: the components' actions, and client errors no session hears. Returns the page's logFailure. */
export function logFailures(client, log) {
  const logFailure = (code, action) => log.add(code, [action, problems[code]].filter(Boolean).join(": "));
  document.addEventListener("ams-failure", ({ detail: { action, error } }) => logFailure(codeOf(error), action));
  client.on("error", ({ error, streamId }) => streamId || logFailure(error));
  return logFailure;
}
