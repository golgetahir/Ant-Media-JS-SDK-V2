# Migrating from v1 (`WebRTCAdaptor`) to v2

This guide is for code that uses the v1 `WebRTCAdaptor` from the StreamApp JavaScript SDK (`webrtc_adaptor.js`, `media_manager.js`). It lists where each v1 method, option, callback and error went.

## What changes

- **One client per connection.** `new WebRTCClient({ websocketURL })` holds the websocket. It can publish and play several streams at once.
- **Sessions.** `client.publish(id)` and `client.play(id)` return a session object for that stream. Calls about one stream (`stop`, `sendData`, stats, bandwidth, track control) move to the session and lose their `streamId` argument.
- **Promises instead of a callback.** `session.ready()` resolves when the stream is live and rejects with an `SDKError` when it fails. Server queries return their answer.
- **Typed events.** `client.on("publish_started", ({ streamId }) => ...)` replaces the `callback(info, obj)` switch, and `client.on("error", ...)` replaces `callbackError`.
- **Local devices under `client.media`.** Camera, microphone and screen share methods are on the `MediaManager` at `client.media`, without a stream id.
- **The camera opens on the first publish**, not in the constructor. There is no play mode to set: a client that only plays never asks for camera permission.

A v1 publisher:

```js
const adaptor = new WebRTCAdaptor({
  websocketURL,
  mediaConstraints: { video: true, audio: true },
  localVideoId: "localVideo",
  callback: (info, obj) => {
    if (info === "initialized") adaptor.publish("stream1", token);
    else if (info === "publish_started") console.log("live");
  },
  callbackError: (error, message) => console.error(error, message),
});
```

The same in v2:

```ts
import { WebRTCClient } from "@antmedia/webrtc-sdk";

const client = new WebRTCClient({
  websocketURL,
  mediaConstraints: { video: true, audio: true },
  localVideo: document.getElementById("localVideo") as HTMLVideoElement,
});
client.on("error", ({ error, message }) => console.error(error, message));

const session = await client.publish("stream1", { token }).ready();
console.log("live", session.streamId);
```

You do not wait for `initialized`: `publish()` and `play()` wait for the socket themselves.

## Methods

`client` is a `WebRTCClient`, `session` any session, `publishSession` a `PublishSession`, `playSession` a `PlaySession`. "Not in v2" means there is no equivalent.

| v1 `WebRTCAdaptor` | v2 |
| --- | --- |
| `publish(streamId, token, subscriberId, subscriberCode, streamName, mainTrack, metaData, role)` | `client.publish(streamId, { token, subscriberId, subscriberCode, streamName, roomId, metaData, role })`. `mainTrack` is now `roomId`. |
| `play(streamId, token, roomId, enableTracks, subscriberId, subscriberCode, metaData, role)`, or `play({ ... })` | `client.play(streamId, { token, roomId, enableTracks, subscriberId, subscriberCode, subscriberName, metaData, role, disableTracksByDefault, userPublishId, remoteVideo })` |
| `stop(streamId)` | `session.stop()` |
| `join(streamId)` | Not in v2 (peer-to-peer). |
| `leave(streamId)` | Not in v2 (peer-to-peer). |
| `joinRoom(roomName, streamId, mode, streamName, role, metadata)` | `client.joinRoom({ roomId, streamId, mode, streamName, role, metaData })`. For multitrack rooms, publish with `roomId` and play the room instead. |
| `leaveFromRoom(roomName, streamId)` | `client.leaveRoom(roomId, streamId)` |
| `getRoomInfo(roomName, streamId)` | `await client.getRoomInfo(roomId, streamId)` |
| `enableTrack(mainTrackId, trackId, enabled)` | `playSession.enableTrack(trackId, enabled)` |
| `getTracks(streamId, token)` | `await client.getTracks(streamId, token)` |
| `getSubtracks(streamId, role, offset, size)` | `await client.getSubtracks(streamId, role, offset, size)` |
| `getSubtrackCount(streamId, role, status)` | `await client.getSubtrackCount(streamId, role, status)` |
| `getStreamInfo(streamId)` | `await client.getStreamInfo(streamId)` |
| `getBroadcastObject(streamId)` | `await client.getBroadcastObject(streamId)` |
| `getSubscriberCount(streamId)` | `await client.getSubscriberCount(streamId)` |
| `getSubscriberList(streamId, offset, size)` | `await client.getSubscriberList(streamId, offset, size)` |
| `forceStreamQuality(streamId, resolution)` | `playSession.forceStreamQuality(height)`, `0` for automatic |
| `changeBandwidth(bandwidth, streamId)` | `publishSession.changeBandwidth(bandwidth)` |
| `sendData(streamId, data)` | `session.sendData(data)` |
| `peerMessage(streamId, definition, data)` | Not in v2 (peer-to-peer). |
| `enableStats(streamId, periodMs)` | `session.enableStats(periodMs)` |
| `disableStats(streamId)` | `session.disableStats()` |
| `getStats(streamId)` | `session.getStats()` |
| `toggleVideo(streamId, trackId, enabled)` | `playSession.toggleVideo(trackId, enabled)` |
| `toggleAudio(streamId, trackId, enabled)` | `playSession.toggleAudio(trackId, enabled)` |
| `assignVideoTrack(videoTrackId, streamId, enabled)` | `playSession.assignVideoTrack(videoTrackId, streamId, enabled)` |
| `updateVideoTrackAssignments(streamId, offset, size)` | `playSession.updateVideoTrackAssignments(offset, size)` |
| `setMaxVideoTrackCount(streamId, maxTrackCount)` | `playSession.setMaxVideoTrackCount(maxTrackCount)` |
| `requestVideoTrackAssignments(streamId)` | `playSession.requestVideoTrackAssignments()` |
| `updateStreamMetaData(streamId, metaData)` | `publishSession.updateStreamMetaData(metaData)` |
| `registerPushNotificationToken(subscriberId, authToken, pushNotificationToken, tokenType)` | `client.registerPushNotificationToken(subscriberId, authToken, pushToken, tokenType)` |
| `sendPushNotification(subscriberId, authToken, content, subscriberIdsToNotify)` | `client.sendPushNotification(subscriberId, authToken, content, subscriberIdsToNotify)` |
| `sendPushNotificationToTopic(subscriberId, authToken, content, topic)` | `client.sendPushNotificationToTopic(subscriberId, authToken, content, topic)` |
| `muteLocalMic()` | `client.media.muteLocalMic()` |
| `unmuteLocalMic()` | `client.media.unmuteLocalMic()` |
| `turnOffLocalCamera(streamId)` | `client.media.turnOffLocalCamera()` |
| `turnOnLocalCamera(streamId)` | `client.media.turnOnLocalCamera()` |
| `switchVideoCameraCapture(streamId, deviceId)` | `client.media.selectVideoInput(deviceId)`. To leave a screen share, call `client.media.stopScreenShare()`. |
| `switchVideoCameraFacingMode(streamId, facingMode)` | `client.media.selectVideoInput({ facingMode })` |
| `switchAudioInputSource(streamId, deviceId)` | `client.media.selectAudioInput(deviceId)` |
| `switchDesktopCapture(streamId)` | `client.media.startScreenShare()` |
| `switchDesktopCaptureWithCamera(streamId)` | `client.media.startScreenWithCameraOverlay()` |
| `setVolumeLevel(volumeLevel)` | `client.media.setVolumeLevel(level)` |
| `enableAudioLevelForLocalStream(levelCallback, period)` | `client.media.enableAudioLevelForLocalStream(callback, periodMs)` |
| `disableAudioLevelForLocalStream()` | `client.media.disableAudioLevelForLocalStream()` |
| `enableAudioLevelWhenMuted()` | `client.media.enableAudioLevelWhenMuted(speaking => ..., threshold)`. The callback replaces the `speaking_but_muted` event. |
| `disableAudioLevelWhenMuted()` | `client.media.disableAudioLevelWhenMuted()` |
| `enableAudioLevel(stream, streamId)` | Not in v2. `playSession.enableRemoteAudioLevel(callback, periodMs)` meters a played stream through a callback. |
| `getSoundLevelList(streamsList)` | Not in v2. |
| `applyConstraints(constraints)` | Not in v2. |
| `closeStream()` | `client.media.dispose()`, which releases every local track. `client.close()` also does it. |
| `closeWebSocket()` | `client.close()` |
| `getDebugInfo(streamId)` | Not in v2. |
| `iceConnectionState(streamId)` | `session.peerConnection?.iceConnectionState` |
| `signallingState(streamId)` | `session.peerConnection?.signalingState` |
| `WebRTCAdaptor.register(pluginInitMethod)` | `WebRTCClient.register(init)`. `init` runs once for each client, when its socket first opens. |
| `addEventListener(listener)` | `client.on(event, handler)` |
| `addErrorEventListener(errorListener)` | `client.on("error", handler)` |
| `openStream(mediaConstraints, streamId)` | `client.media.initLocalStream()`, with the constraints given at construction. |
| `getVideoSender(streamId)` | `session.peerConnection?.getSenders()` |
| `updateVideoTrack(stream, streamId, onEndedCallback, stopDesktop)` | Not in v2. |
| `updateAudioTrack(stream, streamId, onEndedCallback)` | Not in v2. |
| `updateAudioLevel(streamId, value)` | Not in v2. |

New in v2, with no v1 counterpart: `client.ready()`, `session.state`, `publishSession.setDegradationPreference()`, `playSession.enableRemoteAudioLevel()` and `disableRemoteAudioLevel()`, `client.media.pauseLocalTrack()` and `resumeLocalTrack()`, `client.media.setAudioOutput(deviceId, element)`.

## Constructor options

| v1 option | v2 |
| --- | --- |
| `websocketURL`, `websocket_url` | `websocketURL` |
| `httpEndpointUrl` | Not in v2. |
| `mediaConstraints` | `mediaConstraints`, passed to `getUserMedia` as is. The v1 values `"screen"`, `"screen+camera"` and `"dummy"` are not supported; call `client.media.startScreenShare()` or `startScreenWithCameraOverlay()`. |
| `localVideoId`, `localVideoElement` | `localVideo` (the element) |
| `remoteVideoId`, `remoteVideoElement` | `remoteVideo` in the options of each `play()` |
| `isPlayMode` | Not needed. The camera opens only for a publish with media. |
| `onlyDataChannel` | `dataOnly: true` in the options of `publish()` |
| `debug` | `debug` |
| `peerconnection_config` | `peerConnectionConfig` |
| `reconnectIfRequiredFlag` | `autoReconnect` |
| `callback` | `client.on(event, handler)` per event |
| `callbackError` | `client.on("error", handler)` |
| `bandwidth` | `publishSession.changeBandwidth(kbps)` after the stream is live |
| `degradationPreference` | `publishSession.setDegradationPreference(preference)` after the stream is live |
| `dataChannelEnabled` | Not in v2. Publish sessions always create a data channel. |
| `candidateTypes` | Not in v2. UDP and TCP candidates are used. |
| `sdp_constraints` | Not in v2. |
| `initializeComponents` | Not in v2. The constructor always opens the socket. |
| `isMultiPeer` | Not in v2 (peer-to-peer). |
| `camera_location`, `camera_margin`, `camera_percent` | Not in v2. The overlay camera is drawn top right, 15 px from the edges, at 15% of the width. |
| `volumeMeterUrl` | Not needed. Audio levels are read with an `AnalyserNode`. |
| `fallbackToAudioIfVideoPermissionDenied` | Not in v2. |

New in v2: `reconnectConfig` (backoff), `sanitizeDataChannelStrings`, `mediaManager` (a shared `MediaManager`).

## Callbacks and error codes

v1 `callback(info, obj)` names and their v2 events:

| v1 `info` | v2 event |
| --- | --- |
| `initialized` | `initialized` |
| `closed` | `closed` |
| `server_will_stop` | `server_will_stop` |
| `publish_started`, `publish_finished` | `publish_started`, `publish_finished` |
| `play_started`, `play_finished` | `play_started`, `play_finished` |
| `ice_connection_state_changed` | `ice_connection_state_changed` |
| `reconnection_attempt_for_publisher`, `reconnection_attempt_for_player` | same names; the payload is `{ streamId }` instead of the id |
| `newTrackAvailable`, `newStreamAvailable` | `newTrackAvailable` |
| `data_received` | `data_received` |
| `data_channel_opened`, `data_channel_closed` | same names; the payload is `{ streamId }` instead of the id |
| `updated_stats` | `updated_stats` |
| `available_devices` | `devices_updated`, grouped by kind |
| `screen_share_stopped` | `screen_share_stopped` |
| `roomInformation` | `room_information` |
| `streamInformation` | `stream_information` |
| `trackList` | `track_list` |
| `joinedTheRoom` | `room_joined` |
| `leavedFromRoom` | `room_left` |
| `broadcastObject` | `broadcast_object` |
| `subscriberCount` | `subscriber_count` |
| `subscriberList` | `subscriber_list` |
| `subtrackList` | `subtrack_list` |
| `subtrackCount` | `subtrack_count` |
| `speaking_but_muted` | the callback of `client.media.enableAudioLevelWhenMuted()` |
| any other notification, such as `bitrateMeasurement` | `notification:<definition>` |
| `data_received` carrying `VIDEO_TRACK_ASSIGNMENT_LIST` or `TRACK_LIST_UPDATED` (v1 delivered these only as text) | `video_track_assignments`, `track_list_updated`, in addition to `data_received` |

v1 `callbackError(error)` codes that keep their name in v2 as `SDKError.code` and in the `error` event: `WebSocketNotConnected`, `getUserMediaIsNotAllowed`, `NotAllowedError`, `NotFoundError`, `NotReadableError`, `OverconstrainedError`, `notSetRemoteDescription`, `data_channel_error`, and every server error definition (`no_stream_exist`, `streamIdInUse`, `unauthorized_access` and the rest). v1 reported any `getUserMedia` error under its browser name; v2 keeps the four names above and reports the others as `getUserMediaIsNotAllowed`.

v1 error codes v2 does not produce: `protocol_not_supported`, `WebSocketNotSupported`, `UnsecureContext`, `ScreenSharePermissionDenied` (`startScreenShare()` rejects with the browser's error instead), `NoActiveConnection`.

v1 callbacks v2 does not produce: `pong`, `peerMessageCommand`, `gotSoundList`, `audio_only_fallback`, `browser_screen_share_supported`.

## Not in v2 yet

These v1 features have no v2 equivalent:

- Peer-to-peer sessions: `join`, `leave`, `peerMessage`, `isMultiPeer`.
- `applyConstraints` on the running camera or microphone.
- Sound meters by stream id: `enableAudioLevel` and `getSoundLevelList`.
- Video effects and virtual background (the v1 `VideoEffect` plugin in `video-effect.js`).
- `getDebugInfo`.
- `updateAudioLevel`, which sent an `UPDATE_AUDIO_LEVEL` message.
- Sending a track you made yourself: `updateVideoTrack`, `updateAudioTrack`, and `openStream` with new constraints.
- `httpEndpointUrl`, and the `target=origin|edge` parameter v1 added to the websocket URL.
- The audio-only fallback when camera permission is denied.
- Turning the data channel off (`dataChannelEnabled`) and choosing candidate protocols (`candidateTypes`).
- Overlay position and size options.

## Behaviour differences

- **Camera.** v1 opened the camera in the constructor unless `isPlayMode` or `onlyDataChannel` was set. v2 opens it on the first publish with media, or when you call `client.media.initLocalStream()`.
- **Finished events.** A session that never went live emits no `publish_finished` or `play_finished`; its `ready()` rejects instead. A session that went live emits its finished event once, as its last event.
- **Play recovery.** A live play session is recovered until you call `stop()`. The server's `play_finished` reaches the session's listeners but does not end the session.
- **Recovery events.** v1 emitted `reconnection_attempt_for_*` on every retry. v2 emits it once per recovery and adds `reconnected` when ICE connects again. Recovery uses backoff per stream.
- **Remote video and tracks.** With `remoteVideoId`, v1 set the element and did not emit `newTrackAvailable`. v2 sets `remoteVideo` and emits `newTrackAvailable` for every track.
- **`userPublishId`.** v1 sent its own publish id with every play. v2 sends `userPublishId` only when you pass it.
- **Bitrate and degradation defaults.** v1 capped the video at 1200 kbps when a publish connected, and set `maintain-resolution` on the video sender. v2 sets neither. A value set with `changeBandwidth` or `setDegradationPreference` is applied again after each recovery.
- **Received text.** v1 escaped `<` and `>` in any received string containing `script`. v2 passes text through unchanged unless `sanitizeDataChannelStrings: true`, which escapes every `<` and `>`.
- **Sending without a channel.** v1 `sendData` returned without sending when the channel was not open. v2 rejects with `data_channel_not_available`.
- **Sending large binary data.** v1 had no sending limit. v2 rejects binary data over 64 MiB with `data_too_large`, the most the receiving side reassembles.
- **`changeBandwidth` without a sender.** v1 rejected. v2 resolves and does nothing.
- **Duplicate ids.** Publishing or playing an id already active on the same client rejects with `streamIdInUse` without contacting the server.
