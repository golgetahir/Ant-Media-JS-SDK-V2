# Event matrix

Every event the SDK emits, with its payload and where it is delivered.

**Delivered on** says who can listen:

- **Client**: `client.on(...)` receives it.
- **Client, session**: the client receives it, and so does the session whose stream id is in the payload's `streamId`, while that session is starting, live or reconnecting. A session's `on()` accepts only these events.

The finished events also reach a session when it ends; see their rows.

## Events

| Event | Payload | Delivered on | When |
| --- | --- | --- | --- |
| `initialized` | none | Client | The websocket opened, the first time and after every reconnect. |
| `closed` | the socket's `CloseEvent`, or `undefined` | Client | The websocket closed, or a connection attempt did not open within 10 seconds and was abandoned. After `client.close()` or such an attempt the payload is `undefined`. |
| `server_will_stop` | the frame | Client | The server is shutting down (notification `server_will_stop`, also emitted as `notification:server_will_stop`). The client then drops the socket, emits `closed`, and reconnects with backoff. |
| `publish_started` | `{ streamId }` | Client, session | The server reports the published stream live. Fires again after each recovery. |
| `play_started` | `{ streamId }` | Client, session | The server reports the played stream playing. Fires again after each recovery. |
| `publish_finished` | `{ streamId }` | Client, session | Client: the server's finished notification (not during a recovery); or, when a live stream ends without one (`close()`, a server stop command, or `stop()` with the socket down or unanswered for 3 seconds), from the SDK. Session: the server's finished notification while the session is active (the source stopped; the session stays). And once, as its last event, when a session that went live ends by `stop()`, `close()` or a server stop command; the server's answer to `stop()` is that event, not one more. A session that never went live gets none. |
| `play_finished` | `{ streamId }` | Client, session | As `publish_finished`, for a played stream. |
| `ice_connection_state_changed` | `{ state, streamId }` | Client, session | The ICE connection state of the stream's peer changed. |
| `reconnection_attempt_for_publisher` | `{ streamId }` | Client, session | A recovery of a published stream starts: its peer connection failed, or the websocket was lost while it was live. Once per recovery. |
| `reconnection_attempt_for_player` | `{ streamId }` | Client, session | A recovery of a played stream starts: its peer connection failed, or the websocket was lost while it was live. Once per recovery. |
| `reconnected` | `{ streamId }` | Client, session | ICE connected again after a recovery. |
| `updated_stats` | `PeerStats` | Client, session | A statistics sample was taken, by `getStats()` or `enableStats()`. |
| `data_channel_opened` | `{ streamId }` | Client, session | The stream's data channel opened. |
| `data_channel_closed` | `{ streamId }` | Client, session | The stream's data channel closed. |
| `data_received` | `{ streamId, data }`; `data` is `string` or `ArrayBuffer` | Client, session | A text message, or a complete binary message, arrived on the data channel. |
| `newTrackAvailable` | `{ stream, track, streamId, trackId }` | Client, session | A remote track arrived. `trackId` is the id the server mapped to the track, else the track's own id. |
| `error` | `{ error, message?, streamId? }` | Client, session | Something failed; `error` is the code. The session receives it only when `streamId` is set. |
| `devices_updated` | `GroupedDevices`: `videoInputs`, `audioInputs`, `audioOutputs`, `selectedVideoInputId?`, `selectedAudioInputId?`, `selectedAudioOutputId?` | Client | The device list was read: after the local stream opens, on a device change, on `listDevices()`, and after selecting a device or audio output. |
| `local_tracks_changed` | none | Client | A local track was replaced: device switch, camera on or off, screen share. |
| `local_track_paused` | `{ kind }`, `"audio"` or `"video"` | Client | `media.pauseLocalTrack(kind)` with a local stream; `media.muteLocalMic()` is `pauseLocalTrack("audio")`. |
| `local_track_resumed` | `{ kind }` | Client | `media.resumeLocalTrack(kind)` with a local stream; `media.unmuteLocalMic()` is `resumeLocalTrack("audio")`. |
| `screen_share_stopped` | none | Client | The user ended a screen share, with or without the camera overlay, from the browser's own control. The camera comes back on its own. |
| `room_information` | `RoomInformation`: `room`, `streamList`, `streams`, `ATTR_ROOM_NAME?` | Client | Answer to `getRoomInfo()`. |
| `room_joined` | `RoomJoined`: the `RoomInformation` fields, `streamId`, `maxTrackCount?` | Client, session | Server notification `joinedTheRoom`, the answer to `joinRoom()`. |
| `room_left` | `RoomLeft`: `ATTR_ROOM_NAME?`, `streamId?` | Client, session | Server notification `leavedFromRoom` (or `leavedTheRoom`), the answer to `leaveRoom()`. |
| `broadcast_object` | `{ streamId, broadcast? }`; `broadcast` is a JSON string | Client, session | Answer to `getBroadcastObject()`. |
| `subscriber_count` | `{ streamId, count }` | Client, session | Answer to `getSubscriberCount()`. |
| `subscriber_list` | `{ streamId, subscriberList }`; each entry a JSON string | Client, session | Answer to `getSubscriberList()`. |
| `stream_information` | `{ streamId, streamInfo }`; entries have `streamWidth`, `streamHeight`, `videoBitrate`, `audioBitrate`, `videoCodec` | Client, session | Answer to `getStreamInfo()`. |
| `track_list` | `{ streamId, trackList }` | Client, session | Answer to `getTracks()`. |
| `subtrack_list` | `{ streamId, subtrackList }`; each entry a JSON string | Client, session | Answer to `getSubtracks()`. |
| `subtrack_count` | `{ mainTrack, count, role?, status? }` | Client | Answer to `getSubtrackCount()`. |
| `video_track_assignments` | `{ streamId, payload }`; entries have `videoLabel`, `trackId`, `reserved` | Client, session | The server's `VIDEO_TRACK_ASSIGNMENT_LIST` message arrived on a played room's data channel. |
| `track_list_updated` | `{ streamId }` | Client, session | The server's `TRACK_LIST_UPDATED` message arrived on a played room's data channel: the room's tracks changed. |

The query answers fire whether or not the query was made with the promise method, for example when another part of the page asked.

`devices_updated`, `local_tracks_changed`, `local_track_paused`, `local_track_resumed` and `screen_share_stopped` come from the `MediaManager`. You can also listen to them on `client.media`, along with its `error` events (`set_sink_id_failed`, `set_sink_id_unsupported`).

A handler that throws does not stop the others; the SDK logs the exception.

## The `notification:<definition>` channel

Every notification frame from the server is also emitted on the client as `notification:<definition>`, with the raw frame as the payload (typed `unknown`), for example `notification:bitrateMeasurement`.

## Error codes

These are the codes the SDK produces itself. Each appears as `SDKError.code` on a rejected promise, as `error` in the `error` event, or both.

| Code | Trigger |
| --- | --- |
| `WebSocketNotConnected` | The websocket failed, closed, or did not open within 10 seconds while something waited on it (`client.ready()`, a start, a query); a command was sent while it was not open; or `ready()` was called after `close()`. |
| `NotAllowedError`, `NotFoundError`, `NotReadableError`, `OverconstrainedError` | Opening the camera and microphone for a publish failed with this browser error. `NotAllowedError` means permission was denied. |
| `getUserMediaIsNotAllowed` | Opening the camera and microphone for a publish failed with any other error. |
| `notSetRemoteDescription` | The browser rejected the server's SDP. |
| `notSetLocalDescription` | Creating or applying the local SDP failed. |
| `no_local_stream` | The server asked to start a media publish, but there is no local stream. |
| `streamIdInUse` | `publish()` or `play()` with an id already active on this client. The server also uses this code. |
| `stream_stopped` | `stop()` or `close()` was called before the stream went live. |
| `timeout` | No `publish_started` or `play_started` within 15 seconds of the start command, or no answer to a query within 10 seconds. |
| `data_channel_error` | The data channel reported an error while open. |
| `data_channel_blob_parse_failed` | A `Blob` message from the data channel could not be read. |
| `data_channel_not_available` | `sendData()` without an open data channel. |
| `set_sink_id_failed` | `media.setAudioOutput()` failed on the element. |
| `set_sink_id_unsupported` | `media.setAudioOutput()` on an element without `setSinkId`. |
| `session_not_live` | A session method was called while the session was `starting`. |
| `session_ended` | A session method was called after the session `ended`. |

Error frames from the server arrive unchanged: their `definition` becomes the code, for example `no_stream_exist`, `streamIdInUse` or `unauthorized_access`.
