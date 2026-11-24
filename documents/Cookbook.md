# Cookbook

Recipes for common tasks. Each one stands on its own. Unless a recipe creates its own, `client` is a `WebRTCClient` connected to your server, and `websocketURL` is the server's websocket address, such as `wss://your-server:5443/LiveApp/websocket`.

- [Publish with a token](#publish-with-a-token)
- [Play into a video element](#play-into-a-video-element)
- [Play without a video element](#play-without-a-video-element)
- [Conference](#conference)
- [Data-only publishing](#data-only-publishing)
- [Send and receive data](#send-and-receive-data)
- [Camera, microphone and screen share](#camera-microphone-and-screen-share)
- [Bandwidth and degradation preference](#bandwidth-and-degradation-preference)
- [Statistics](#statistics)
- [Reconnect](#reconnect)
- [Handle a failed start](#handle-a-failed-start)
- [Cancel a start](#cancel-a-start)
- [Stop and close](#stop-and-close)
- [Custom ICE servers](#custom-ice-servers)
- [Share one MediaManager between clients](#share-one-mediamanager-between-clients)

## Publish with a token

Pass the token in the publish options. The first publish opens the camera and microphone with `mediaConstraints` (default `{ video: true, audio: true }`).

```ts
import { SDKError, WebRTCClient } from "@antmedia/webrtc-sdk";

const client = new WebRTCClient({
  websocketURL,
  localVideo: document.querySelector<HTMLVideoElement>("#local"),
  mediaConstraints: { video: { width: 1280, height: 720 }, audio: true },
});

try {
  const session = await client
    .publish("stream1", { token: "<publish token>", streamName: "Lobby camera" })
    .ready();
  console.log("live", session.streamId);
} catch (e) {
  if (e instanceof SDKError && e.code === "unauthorized_access") console.error("token rejected");
  else throw e;
}
```

With token security on, a missing or wrong token makes the server answer `unauthorized_access`, and `ready()` rejects with that code.

| Publish option | Meaning |
| --- | --- |
| `token` | Stream token, when token security is on. |
| `roomId` | Room to publish into. Your stream becomes a track of the room (sent as `mainTrack`). |
| `streamName` | Stream name sent to the server. |
| `metaData` | Metadata stored with the stream. |
| `role` | Role of the stream, used for selective forwarding in rooms. |
| `subscriberId`, `subscriberCode` | Subscriber id and one-time code, when the server requires them. |
| `dataOnly` | Publish a data channel only. No camera or microphone is used. |

## Play into a video element

Pass the element as `remoteVideo`. It gets the remote `MediaStream` as `srcObject` when the first track arrives.

```ts
const remoteVideo = document.querySelector<HTMLVideoElement>("#remote");
const session = await client.play("stream1", { remoteVideo, token: "<play token>" }).ready();

// pick a rendition when adaptive bitrate is on
const { streamInfo } = await client.getStreamInfo("stream1");
await session.forceStreamQuality(streamInfo[0].streamHeight);
await session.forceStreamQuality(0); // back to automatic
```

`forceStreamQuality` takes a height from `streamInfo`, or `0` for automatic quality. The example page uses `<video autoplay controls playsinline>`.

| Play option | Meaning |
| --- | --- |
| `token` | Stream token, when token security is on. |
| `remoteVideo` | Element that receives the stream. |
| `roomId` | Room to play (sent as `room`). |
| `enableTracks` | Track ids to receive from a multitrack stream. |
| `disableTracksByDefault` | Start with tracks disabled. Default `false`. |
| `subscriberId`, `subscriberCode`, `subscriberName` | Subscriber identity, when the server requires it. |
| `metaData` | Viewer information (sent as `viewerInfo`). |
| `role` | Role of the viewer, used for selective forwarding in rooms. |
| `userPublishId` | Id of the stream this client publishes into the same room. v1 filled it in for you; v2 does not. |

## Play without a video element

Listen for tracks and attach the stream yourself. Attach the listener before `ready()`, because tracks can arrive before the stream is reported live.

```ts
const video = document.createElement("video");
video.autoplay = true;
video.playsInline = true;
document.body.append(video);

const session = client.play("stream1");
session.on("newTrackAvailable", ({ track, stream }) => {
  console.log("track", track.kind);
  if (video.srcObject !== stream) video.srcObject = stream;
});
await session.ready();
```

`session.stream` is the `MediaStream` of the most recent incoming track. It is `null` until the first track arrives and after the session ended. For a room, use `newTrackAvailable`, as below.

## Conference

A conference is a room on the server. Each participant publishes into the room and plays the room. Playing the room delivers the other participants' tracks over one peer connection.

This follows `examples/conference.html`. Each `trackId` in `newTrackAvailable` is a 7-character prefix (`ARDAMSv` for video, `ARDAMSa` for audio) followed by an id, and the page makes one tile per id. Video ids are slot labels such as `videoTrack0`: the server has a limited number of video slots and decides which participant each slot shows.

```ts
const roomId = "room1";
const myId = "alice";

const me = client.publish(myId, { roomId, streamName: "Alice" });
await me.ready();

const room = client.play(roomId, { roomId, userPublishId: myId });

room.on("newTrackAvailable", ({ track, stream, trackId }) => {
  const id = trackId.substring("ARDAMSx".length);
  if (id === roomId || id === myId) return;

  let tile = document.getElementById(`tile-${id}`) as HTMLVideoElement | null;
  if (!tile) {
    tile = document.createElement("video");
    tile.id = `tile-${id}`;
    tile.autoplay = true;
    tile.playsInline = true;
    tile.srcObject = new MediaStream();
    document.body.append(tile);
  }
  (tile.srcObject as MediaStream).addTrack(track);

  stream.onremovetrack = ev => {
    document.getElementById(`tile-${ev.track.id.substring("ARDAMSx".length)}`)?.remove();
  };
});

// which participant each video slot shows
room.on("video_track_assignments", ({ payload }) => {
  for (const slot of payload) {
    document.getElementById(`tile-${slot.videoLabel}`)?.setAttribute("title", slot.trackId);
  }
});

await room.ready();
```

Each `video_track_assignments` entry has `videoLabel` (the slot), `trackId` (the stream id of the participant shown in it) and `reserved`. Change the number of slots and page through the participants:

```ts
await room.setMaxVideoTrackCount(4);          // video slots for this viewer
await room.updateVideoTrackAssignments(4, 4); // participants 4 to 7, counting from 0
await room.requestVideoTrackAssignments();    // ask for the current list
```

`reserved` is the server's own flag: the server also sets it on the slots it fills when paging, so it does not mean pinned. Keep who you pinned yourself.

To pin a participant, put their stream id on a video slot. Release the slot to let the server choose again:

```ts
await room.assignVideoTrack("videoTrack0", "bob", true);  // slot videoTrack0 shows bob
await room.assignVideoTrack("videoTrack0", "bob", false); // unpin
```

To list the participants, ask for the room's subtracks. Each entry is a JSON string of a broadcast object, with `streamId`, `name` and `metaData`. Ask again when someone comes or goes:

```ts
async function participants() {
  const { subtrackList } = await client.getSubtracks("room1", "", 0, 100);
  return subtrackList.map(entry => JSON.parse(entry));
}

room.on("track_list_updated", () => {
  void participants().then(list => console.log("in the room:", list.map(p => p.name)));
  void room.requestVideoTrackAssignments();
});
```

`video_track_assignments` and `track_list_updated` come over the data channel, so the room's data channel must be enabled on the server.

The page shares these conventions with Ant Media's conference app, so both can meet in one room:

- each participant's `metaData` is `JSON.stringify({ isMicMuted, isCameraOn })`, given to `publish()` and updated with `me.updateStreamMetaData()`;
- a microphone or camera change is also sent over the publish session: `JSON.stringify({ streamId: myId, eventType })` with `MIC_MUTED`, `MIC_UNMUTED`, `CAM_TURNED_OFF` or `CAM_TURNED_ON`;
- a chat message is `JSON.stringify({ eventType: "MESSAGE_RECEIVED", message, name, senderId: myId })`, sent over the publish session. The others' notices and messages arrive as `data_received` on the room session; the server sends your own messages back to you there too, so skip those whose `senderId` is yours.

To stop receiving one participant, disable their track. Enable it again to resume:

```ts
await room.enableTrack("bob", false);
await room.enableTrack("bob", true);
```

To leave, stop both sessions and remove the tiles:

```ts
await room.stop();
await me.stop();
document.querySelectorAll("video[id^='tile-']").forEach(v => v.remove());
```

## Data-only publishing

Publish a stream that carries only a data channel. The camera and microphone are not opened.

```ts
const session = client.publish("chat1", { dataOnly: true });
const opened = new Promise<void>(resolve => session.once("data_channel_opened", () => resolve()));
session.on("data_received", ({ data }) => console.log("received", data));

await session.ready();
await opened;
await session.sendData("joined");
```

The channel can open before or after the stream is reported live, and `sendData` needs both, so wait for both.

Others join by playing the same id. `examples/data-channel.html` creates the channel with a data-only publish, and its link opens a second tab that joins it by playing.

## Send and receive data

Both publish and play sessions have a data channel, once the server application has data channels enabled.

```ts
session.on("data_channel_opened", () => console.log("can send"));
session.on("data_channel_closed", () => console.log("cannot send"));

session.on("data_received", ({ data }) => {
  if (typeof data === "string") console.log("text:", data);
  else console.log("binary:", data.byteLength, "bytes");
});

await session.sendData("hello");
await session.sendData(JSON.stringify({ type: "chat", text: "hi" }));

const image = await (await fetch("/logo.png")).arrayBuffer();
await session.sendData(image);
```

Text arrives as a string, binary as an `ArrayBuffer`. Pass binary data as an `ArrayBuffer`; for a typed array, pass its `.buffer`.

Binary messages are sent in chunks of 16000 bytes and reassembled on the other side, in the same format as v1, so v1 and v2 pages can exchange them. Incoming binary messages larger than 64 MiB are not reassembled. `sendData` waits when the channel's buffer is over 1 MiB, so await it before sending the next large message.

`sendData` rejects with `data_channel_not_available` when the channel is not open, `data_too_large` for binary data over 64 MiB, `session_not_live` before the stream is live, and `session_ended` after it ended.

The server also sends its own JSON messages over the data channel. They arrive in `data_received` like any text. Two of them also get their own events: `video_track_assignments` and `track_list_updated`.

To escape `<` and `>` in received text, create the client with `sanitizeDataChannelStrings: true`. It is off by default.

## Camera, microphone and screen share

Local media is under `client.media`. Every publish session of the client follows it: a switched track replaces the outgoing one. Called before the local stream exists, these methods first open the camera and microphone as `client.media.initLocalStream()` would, on the device you selected; `turnOffLocalCamera()` then only records that the camera is off, and the stream opens without it.

```ts
const { videoInputs, audioInputs } = await client.media.listDevices();

await client.media.selectVideoInput(videoInputs[1].deviceId);
await client.media.selectVideoInput({ facingMode: "environment" });
await client.media.selectAudioInput(audioInputs[0].deviceId);

client.media.muteLocalMic();
client.media.unmuteLocalMic();

client.media.turnOffLocalCamera();
await client.media.turnOnLocalCamera();

await client.media.setVolumeLevel(0.5);
```

`client.on("devices_updated", ...)` gives you the device list whenever it changes, with the selected ids.

Mute and camera-off are kept across switches. A microphone selected while muted stays muted. A camera selected while the camera is off is not opened; `turnOnLocalCamera()` opens it.

`turnOffLocalCamera()` stops the camera, so its light goes off, and sends black frames instead. During a screen share, `turnOffLocalCamera()` and `turnOnLocalCamera()` only record the camera state: the screen keeps being sent, the overlay leaves the camera out while it is off, and the recorded state applies when the share ends.

`setVolumeLevel(level)` takes 0 to 1. The first call routes the microphone through a gain node.

`pauseLocalTrack(kind)` and `resumeLocalTrack(kind)` disable and enable the local audio or video track and, when a local stream exists, emit `local_track_paused` and `local_track_resumed`. `muteLocalMic()` and `unmuteLocalMic()` are `pauseLocalTrack("audio")` and `resumeLocalTrack("audio")`, events included.

Share the screen, with or without a camera overlay:

```ts
await client.media.startScreenShare();
await client.media.stopScreenShare();

await client.media.startScreenWithCameraOverlay();
await client.media.stopScreenWithCameraOverlay();
```

`startScreenShare()` asks for the screen with audio. If the user shares audio, it is mixed with the microphone; `client.media.enableSecondStreamInMixedAudio(false)` silences the microphone in that mix.

The overlay draws the camera into the top-right corner of the screen, 15% of its width, at about 15 frames per second. During a share with the camera overlay, `selectVideoInput()` switches the overlay's camera at once, even while the camera is off; during a plain screen share the selection applies when the share ends.

When the user ends either share from the browser's own control, the camera comes back on its own and the client emits `screen_share_stopped`:

```ts
client.on("screen_share_stopped", () => console.log("share ended"));
```

## Bandwidth and degradation preference

Cap the video bitrate of a publish session in kbit/s, or remove the cap. Set how the browser degrades video under load.

```ts
await session.changeBandwidth(600);
await session.changeBandwidth("unlimited");
await session.setDegradationPreference("maintain-resolution");
```

v2 sets no cap and no degradation preference by default. The session keeps the last value of each and applies it again to the new peer connection after a recovery.

When the browser refuses a value, the SDK logs a warning and the promise still resolves.

## Statistics

Take one sample, or sample periodically and listen for `updated_stats`.

```ts
const stats = await session.getStats();
if (stats) console.log(stats.currentOutgoingBitrate, stats.frameWidth, stats.frameHeight);

session.on("updated_stats", s => {
  console.log(s.currentIncomingBitrate, "kbit/s", s.framesDecoded, "frames decoded");
});
session.enableStats(2000);

session.disableStats();
```

`getStats()` resolves with a `PeerStats`, or `null` when there is no peer connection or the browser fails. Every sample, one-shot or periodic, also emits `updated_stats`.

Bitrates are in kbit/s. `current*Bitrate` compares with the previous sample and `average*Bitrate` with the first, so both appear from the second sample on. `enableStats` samples every 5000 ms unless you pass a period; calling it again while it runs does nothing. Sampling stops when the session ends.

`PeerStats` fields: `streamId`, `currentOutgoingBitrate`, `averageOutgoingBitrate`, `currentIncomingBitrate`, `averageIncomingBitrate`, `totalBytesSent`, `totalBytesReceived`, `currentTimestamp`, `audioPacketsSent`, `videoPacketsSent`, `audioPacketsReceived`, `videoPacketsReceived`, `audioPacketsLost`, `videoPacketsLost`, `audioJitter`, `videoJitter`, `audioRoundTripTime`, `videoRoundTripTime`, `currentRoundTripTime`, `frameWidth`, `frameHeight`, `framesEncoded`, `framesDecoded`, `framesDropped`, `framesReceived`, `availableOutgoingBitrateKbps`. Fields the browser did not report are `undefined`.

## Reconnect

Recovery is on by default. These are the default backoff settings:

```ts
const client = new WebRTCClient({
  websocketURL,
  autoReconnect: true,
  reconnectConfig: { backoff: "exp", baseMs: 500, maxMs: 8000, jitter: 0.2 },
});

client.on("closed", () => console.log("socket lost"));
client.on("initialized", () => console.log("socket open"));
```

The delay before attempt `n` (from 0) is `baseMs * 2^n`, capped at `maxMs`, with `backoff: "exp"`, or `baseMs` with `"fixed"`. `jitter` varies it randomly by up to that fraction.

What gets recovered:

- **The websocket.** When it drops, the client reopens it with backoff. Once it is open again, every live session is restarted.
- **A stream.** When its ICE state becomes `failed` or `closed`, it is restarted. When it becomes `disconnected`, the client waits at least 3 seconds first, and skips the restart if ICE recovers by then.

A restart closes the peer connection and sends the original publish or play command again. It repeats, with the backoff, until ICE connects.

Each recovery shows up on the session like this:

```ts
session.on("reconnection_attempt_for_publisher", () => console.log("recovering"));
session.on("reconnected", () => console.log("recovered", session.state)); // "live"
```

`reconnection_attempt_for_publisher` (or `_for_player`) fires once when a recovery starts; right after it, `session.state` is `reconnecting`. `reconnected` fires when ICE connects again. In between, the data channel is recreated, so `data_channel_opened` fires again, and `publish_started` or `play_started` fires again when the server accepts the restart.

After a socket drop, only streams that were live are restarted. A start in flight at that moment fails with `WebSocketNotConnected`.

When the server ends a playback on its side, it sends `play_finished`. That reaches the session too, but the session does not end: it stays active and is recovered whenever its connection drops, until you stop it. To end it then:

```ts
session.on("play_finished", () => void session.stop());
```

`stop()` delivers one more `play_finished`, the session's last; `stop()` on the ended session then does nothing.

With `autoReconnect: false`, nothing is recovered: not the socket, not the streams. `client.ready()` then opens a new socket attempt when called.

## Handle a failed start

`ready()` rejects with an `SDKError`. The session is then `ended`; start a new one to try again.

```ts
import { SDKError } from "@antmedia/webrtc-sdk";

const session = client.play("stream1", { remoteVideo });
try {
  await session.ready();
} catch (e) {
  if (!(e instanceof SDKError)) throw e;
  if (e.code === "no_stream_exist") console.log("not live yet");
  else if (e.code === "timeout") console.log("server did not confirm in time");
  else if (e.code === "WebSocketNotConnected") console.log("no connection to the server");
  else console.log("failed:", e.code);
  console.log(session.state); // "ended"
}
```

The server has 15 seconds to report the stream live after the command is sent. For a publish, the command is sent after the camera and microphone are open, so time spent on a permission prompt does not count.

Camera and microphone failures reject with the browser's error name as the code (`NotAllowedError`, `NotFoundError`, `NotReadableError`, `OverconstrainedError`) or `getUserMediaIsNotAllowed` for any other. They also fire the client's `error` event.

Publishing or playing an id that is already active on the same client rejects at once with `streamIdInUse`.

## Cancel a start

Call `stop()` before the stream is live. `ready()` then rejects with `stream_stopped`, and no finished event fires.

```ts
import { SDKError } from "@antmedia/webrtc-sdk";

const session = client.publish("stream1");
const timer = setTimeout(() => void session.stop(), 5000);

try {
  await session.ready();
} catch (e) {
  if (e instanceof SDKError && e.code === "stream_stopped") console.log("cancelled");
} finally {
  clearTimeout(timer);
}
```

## Stop and close

End one session with `stop()`. End everything with `close()`.

```ts
session.on("publish_finished", () => console.log("ended"));
await session.stop();
console.log(session.state); // "ended"

client.close();
```

`stop()` never rejects. It resolves when the server confirms, or after 3 seconds, or at once when the socket is down. A session that was live emits its finished event (`publish_finished` or `play_finished`) once, as its last event. Calling `stop()` on an ended session does nothing.

`close()` ends every session, closes the socket, stops recovery and releases the camera and microphone (unless you passed your own `MediaManager`; see the last recipe). It emits `closed`. A closed client cannot reconnect: `ready()` rejects with `WebSocketNotConnected`. Create a new client to connect again.

## Custom ICE servers

Pass `peerConnectionConfig`. It is merged into the configuration of every peer connection.

```ts
const client = new WebRTCClient({
  websocketURL,
  peerConnectionConfig: {
    iceServers: [
      { urls: "stun:stun.example.com:3478" },
      { urls: "turn:turn.example.com:3478", username: "user", credential: "secret" },
    ],
  },
});
```

Without your own `iceServers`, the client starts with `stun:stun1.l.google.com:19302` and asks the server for its STUN or TURN settings each time the socket opens. Your own `iceServers` are never replaced by the server's.

## Share one MediaManager between clients

Create a `MediaManager` yourself and pass it to each client, for example to show a preview before connecting, or to publish the same camera to two servers.

```ts
import { MediaManager, WebRTCClient } from "@antmedia/webrtc-sdk";

const media = new MediaManager({
  mediaConstraints: { video: true, audio: true },
  localVideo: document.querySelector<HTMLVideoElement>("#local"),
});
await media.initLocalStream();

const first = new WebRTCClient({ websocketURL, mediaManager: media });
const second = new WebRTCClient({ websocketURL: otherWebsocketURL, mediaManager: media });

await first.publish("camera1").ready();
await second.publish("camera1").ready();

// later
first.close();
second.close();
media.dispose();
```

With `mediaManager`, the client's own `localVideo` and `mediaConstraints` options are not used; give them to the `MediaManager`. `close()` does not release an injected manager; call `dispose()` when no client needs it.
