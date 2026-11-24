# Ant Media WebRTC SDK v2

A TypeScript library for publishing and playing WebRTC streams with Ant Media Server from the browser. It covers publish, play, multitrack rooms, the data channel, local devices, screen share, statistics and automatic recovery after network drops. The SDK is in beta (`2.0.0-beta.1`). This README and the files in `documents/` describe the API as it is in this repository.

## Install

The package is not on npm yet. Build it from this repository:

```bash
npm install
npm run build
```

The build writes an ES module and its type declarations to `dist/`. Import it by path:

```js
import { WebRTCClient } from "./Ant-Media-JS-SDK/dist/index.js";
```

Or run `npm pack` after the build and install the tarball it creates in your project. The package name is `@antmedia/webrtc-sdk`, which is what the examples below import.

## Quick start

Publish a camera stream:

```ts
import { WebRTCClient } from "@antmedia/webrtc-sdk";

const client = new WebRTCClient({
  websocketURL: "wss://your-server:5443/LiveApp/websocket",
  localVideo: document.querySelector<HTMLVideoElement>("#local"),
});

const session = await client.publish("stream1").ready();
console.log("publishing", session.streamId);
```

Play it on another page:

```ts
import { WebRTCClient } from "@antmedia/webrtc-sdk";

const viewer = new WebRTCClient({ websocketURL: "wss://your-server:5443/LiveApp/websocket" });
const playing = await viewer
  .play("stream1", { remoteVideo: document.querySelector<HTMLVideoElement>("#remote") })
  .ready();
```

The same calls can be written listeners first: take the session, attach listeners, then wait for it.

```ts
import { SDKError } from "@antmedia/webrtc-sdk";

const session = client.publish("stream1", { token: "<publish token>" });
session.on("data_channel_opened", () => console.log("data channel open"));
session.on("publish_finished", () => console.log("stream ended"));

try {
  await session.ready();
} catch (e) {
  if (e instanceof SDKError) console.error("publish failed:", e.code);
}
```

Use the one-line form when you only need the stream to be live. Use the listeners-first form when you need events that can fire before it is live, such as incoming tracks, the data channel opening, or errors, or when you may stop it before it starts.

## How it works

A `WebRTCClient` holds one websocket connection to one Ant Media Server application. Create one per server connection. The constructor opens the socket; it does not touch the camera or microphone.

`client.publish()` and `client.play()` return a session at once. A session is one stream that this client publishes (`PublishSession`) or plays (`PlaySession`). Its `ready()` resolves with the session when the server reports the stream live, and rejects with an `SDKError` if the start fails. One client can run several sessions at the same time, each with its own stream id.

A session has a `state`:

| State | Meaning |
| --- | --- |
| `starting` | Not live yet: waiting for the socket, the camera and microphone, or the server's confirmation. |
| `live` | The server reported it live. |
| `reconnecting` | The websocket or the peer connection is being recovered. |
| `ended` | Stopped, failed to start, or closed. Final. |

A session moves `starting → live`, then between `live` and `reconnecting` as the network drops and recovers, and finally to `ended`. A start that fails or is stopped goes `starting → ended`. A session lives until you call `session.stop()` or `client.close()`, or the server sends a stop command. Network drops are recovered on the same session object, so you keep your listeners and references.

Apart from `ready()`, `stop()` and the event methods, session methods need the stream to be live or reconnecting. Before that they fail with `session_not_live`; after the session ended, with `session_ended`.

Local devices (camera, microphone, screen share) are under `client.media`, a `MediaManager`. The first publish with media opens the camera and microphone, unless you called `client.media.initLocalStream()` before, for example to show a preview.

Server queries are methods on the client that return the answer: `getStreamInfo`, `getBroadcastObject`, `getSubscriberCount`, `getSubscriberList`, `getTracks`, `getSubtracks`, `getSubtrackCount` and `getRoomInfo`. Each also emits its event (for example `stream_information`).

Events are typed. Listen with `on(event, handler)`, which returns a function that removes the handler; `once` and `off` also exist. The client receives every event. A session receives the events whose payload names its stream id, the server's finished notification included; a session that went live gets one more finished event when it ends. [documents/EventMatrix.md](documents/EventMatrix.md) lists them all.

## Rooms

Publish your stream into the room, then play the room. The other participants' tracks arrive as `newTrackAvailable` on the room session.

```ts
const me = client.publish("alice", { roomId: "room1" });
await me.ready();

const room = client.play("room1", { roomId: "room1", userPublishId: "alice" });
room.on("newTrackAvailable", ({ track, trackId }) => {
  console.log("track", track.kind, trackId);
});
await room.ready();
```

The [Cookbook](documents/Cookbook.md#conference) shows a full room with video tiles.

## Data channel

```ts
session.on("data_received", ({ data }) => {
  if (typeof data === "string") console.log("text", data);
  else console.log("binary", data.byteLength, "bytes");
});
await session.sendData("hello");
await session.sendData(new Uint8Array([1, 2, 3]).buffer);
```

The data channel must be enabled in the server application's settings. `sendData` rejects with `data_channel_not_available` while the channel is not open; wait for `data_channel_opened`.

## Devices and screen share

```ts
const devices = await client.media.listDevices();
await client.media.selectVideoInput(devices.videoInputs[0].deviceId);
client.media.muteLocalMic();
client.media.turnOffLocalCamera();
await client.media.turnOnLocalCamera();
await client.media.startScreenShare();
await client.media.stopScreenShare();
```

Every publish session follows the local tracks: switching a device or starting a screen share replaces the outgoing track without renegotiation. When the user ends the share from the browser's own control, the camera track comes back on its own (black frames if the camera is turned off).

Called before the local stream exists, these methods first open the camera and microphone as `client.media.initLocalStream()` would, on the device you selected. `turnOffLocalCamera()` then only records that the camera is off, and the stream opens without it.

## Errors

Failures reach you in two ways. A promise rejects with an `SDKError`, whose `code` says what happened. And the `error` event fires with `{ error, message, streamId }`, where `error` is the same kind of code.

```ts
client.on("error", ({ error, streamId }) => {
  console.warn("error", error, streamId ?? "");
});
```

Some codes come from the SDK itself, for example `NotAllowedError` when camera permission is denied or `timeout` when the server does not answer. Error frames from the server keep their server definition as the code, for example `no_stream_exist`, `streamIdInUse` or `unauthorized_access`. The full list is in [documents/EventMatrix.md](documents/EventMatrix.md#error-codes).

## Recovery

Recovery is on by default (`autoReconnect: true`). When the websocket drops, the client reconnects with backoff and restarts every live stream. When a peer connection fails, that stream is restarted.

```ts
session.on("reconnection_attempt_for_player", () => console.log("recovering"));
session.on("reconnected", () => console.log("back", session.state));
```

`reconnection_attempt_for_publisher` is the publish counterpart. Tune the backoff with `reconnectConfig` (see the [Cookbook](documents/Cookbook.md#reconnect)).

## Running the examples

`examples/` holds four pages: `publish.html`, `play.html`, `conference.html` and `data-channel.html`.

Run them from the repository:

```bash
npm run examples
```

This builds the SDK and starts Vite. Open `http://localhost:5173/examples/publish.html` (Vite prints the address). Pages served this way connect to `ws://localhost:5080/LiveApp/websocket`.

Or copy them into a local Ant Media Server:

```bash
./redeploy.sh            # LiveApp, WebRTCAppEE and live
./redeploy.sh LiveApp    # or name the apps
```

The script builds the SDK and copies `dist/` and `examples/` into `$AMS_DIR/webapps/<app>/js-sdk/` (`AMS_DIR` defaults to `$HOME/softwares/ant-media-server`). Open `http://localhost:5080/LiveApp/js-sdk/examples/publish.html`. Pages served from an app connect to that app's websocket.

On either setup, add `?websocketURL=wss://host:5443/App/websocket` to a page address to use another server.

## Development

| Command | What it does |
| --- | --- |
| `npm run build` | Clean `dist/` and compile with `tsc`. |
| `npm run clean` | Remove `dist/`. |
| `npm run typecheck` | Type-check without writing files. |
| `npm run lint` | ESLint over `src/`. `npm run lint:fix` fixes what it can. |
| `npm test` | Run the Vitest suite once. `npm run test:watch` keeps it running. |
| `npm run examples` | Build, then serve the example pages with Vite. |
| `npm run docs` | Generate the API reference into `docs/` with TypeDoc. |

## Documents

- [Cookbook](documents/Cookbook.md): recipes for each task.
- [Event matrix](documents/EventMatrix.md): every event and error code.
- [Migrating from v1](documents/V2-vs-V1.md): `WebRTCAdaptor` to v2, method by method.
- [Manual test plan](documents/ManualTestPlan.md): the release checklist.
