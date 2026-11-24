# Manual test plan

The release checklist. Run it by hand against a real Ant Media Server with the example pages, in Chrome unless a check says otherwise. Use two browsers (or two profiles) when a check needs a publisher and a viewer. Enable the data channel in the application's settings first.

## Get the pages up

Either deploy them into a local server:

```bash
./redeploy.sh LiveApp
```

and open `http://localhost:5080/LiveApp/samples/publish.html`. These pages connect to the app they are served from.

Or serve them from the repository:

```bash
npm run examples
```

and open `http://localhost:5173/examples/publish.html`. These pages connect to `ws://localhost:5080/LiveApp/websocket`.

Add `?websocketURL=<ws or wss address>` to any page to use another server. `publish.html`, `play.html` and `data-only.html` also take `?id=<stream id>`.

Each page exposes its client and sessions on `window` for the console:

| Page | Globals |
| --- | --- |
| `publish.html` | `adaptor`; `session` after Start Publishing |
| `play.html` | `adaptor`; `session` after Start Playing (its log panel is hidden; errors show as a warning on the video) |
| `conference.html` | `adaptor` (also `conferenceClient`); `publishSession` and `playSession` after Join Room |
| `data-only.html` | `adaptor` and `session`, both after Join Channel |

On `publish.html`, open **Options** for devices, camera and microphone controls, screen share, bandwidth and the data channel. After publishing, the **Play with WebRTC** link opens the viewer for the same stream.

## Media and privacy

Publisher on `publish.html`, viewer on `play.html` in a second browser.

- [ ] **Mute Mic**, then pick another **Audio Source**: the viewer hears nothing. **Unmute Mic**: the viewer hears the new microphone.
- [ ] **Mute Mic**, then **Start Share**: the viewer hears nothing from the microphone.
- [ ] **Cam Off**, then plug in or unplug headphones: the viewer still sees black, and the camera light stays off.
- [ ] **Start Share**, then plug in or unplug headphones: the viewer still sees the screen.
- [ ] Run `adaptor.on("screen_share_stopped", () => console.log("share stopped"))` in the console. **Start Share**, then click the browser's own Stop sharing bar: the viewer sees the camera again within two seconds, and the console prints `share stopped` once.
- [ ] The same with **Share + Cam Overlay**.
- [ ] **Start Share**, then **Cam Off**: the viewer keeps seeing the screen. **Cam On**: still the screen, and no new camera prompt. **Cam Off** again, then **Stop Share**: the viewer sees black and the camera light stays off. **Cam On**: the viewer sees the camera.
- [ ] **Share + Cam Overlay**, then **Cam Off**: the viewer keeps seeing the screen, without the camera corner (the overlay keeps its own camera open, so the light stays on). **Cam On**: the corner comes back. **Cam Off**, then **Stop Overlay**: the viewer sees black.
- [ ] A device picked before the first publish. On `play.html` in a profile that already allowed the camera for this server, run, with a new stream id:

  ```js
  const { audioInputs } = await adaptor.media.listDevices();
  await adaptor.media.selectAudioInput(audioInputs[1].deviceId);
  const pub = await adaptor.publish("<new id>").ready();
  pub.peerConnection.getSenders().map((s) => s.track?.kind);
  ```

  The last line lists both `"audio"` and `"video"`. A viewer playing `<new id>` sees the camera and hears the picked microphone. `await pub.stop()` when done.
- [ ] **Cam Off**, then pick another **Video Source**: the camera light stays off. **Cam On**: the viewer sees the camera you picked.
- [ ] Move the gain slider low, then pick another **Audio Source**: the viewer still hears the low level.
- [ ] Run `adaptor.close()` in the console: the camera light goes off, and the console stays quiet for 30 seconds.
- [ ] Two participants in `conference.html`. In one, switch the camera from the console (the page has no camera selector):

  ```js
  const { videoInputs } = await adaptor.media.listDevices();
  await adaptor.media.selectVideoInput(videoInputs[1].deviceId);
  ```

  The other participant sees the new camera. No errors in either console.

## Connection and recovery

- [ ] While publishing and playing, turn the publisher's Wi-Fi off for 10 seconds, then on: the viewer gets video back without a click.
- [ ] The same with the viewer's Wi-Fi.
- [ ] The same with Wi-Fi off for 2 minutes.
- [ ] Restart Ant Media Server while publishing and playing: both recover without a click.
- [ ] On `publish.html` while publishing, set Max Video Bitrate to 300 and **Apply**. Turn Wi-Fi off for 10 seconds, then on. After the log shows `reconnected <id>`, run:

  ```js
  session.peerConnection.getSenders().find((s) => s.track?.kind === "video").getParameters().encodings[0].maxBitrate;
  ```

  It returns `300000`.
- [ ] The publisher stops. Publisher on `publish.html`, viewer on `play.html`. **Stop Publishing**: the play page shows `source stopped, waiting for it to return` on the video (`no_stream_exist` warnings may follow while it waits); its Stop stays enabled and Start disabled. **Start Publishing** again with the same id: the viewer gets video back without a click. **Stop** on the play page then ends it: Start is enabled again.
- [ ] In a fresh browser profile, open `publish.html`; it asks for the camera to show a preview. Click **Start Publishing**, leave the permission prompt open for 10 seconds, then allow: publishing starts.
- [ ] Repeat, and deny: within a second the log shows `error: NotAllowedError` and `publish failed: ...`.
- [ ] Open `publish.html?websocketURL=ws://localhost:5999/LiveApp/websocket` (a port with nothing listening) and click **Start Publishing**: the log shows `error: WebSocketNotConnected` and `publish failed: WebSocketNotConnected`, not an endless wait.
- [ ] While publishing, turn Wi-Fi off, click **Stop Publishing**, turn Wi-Fi on: the stream does not come back, and the server's web panel lists no broadcast for it.
- [ ] Set a TURN server in the application's settings, then play: `chrome://webrtc-internals` shows the TURN server in the configuration of the first play connection.
- [ ] Run `adaptor.close()`: in DevTools, Network, WS, the websocket closes and no new one opens.

## Calls, errors and data

- [ ] On `play.html`, play an id that is not live: the warning on the video says `no_stream_exist`. From the console, `await adaptor.play("no-such-id").ready().catch(e => e.code)` returns `"no_stream_exist"`.
- [ ] On `publish.html`, publish an id that is live in another tab: the log shows `error: streamIdInUse`.
- [ ] With token security on for publishing, publish without a token: the log shows `error: unauthorized_access`.
- [ ] Publish, then **Stop Publishing**: `publish_finished <id>` appears exactly once in the log.
- [ ] In the viewer's console, `await adaptor.getStreamInfo("<a live id>")` returns `{ streamId, streamInfo }` with one entry per rendition.
- [ ] Send text over the data channel from the publisher (**Send**) and from the viewer (Options, **Send**): each side shows the other's message.
- [ ] Binary in both directions. On each side, listen, then send a 1 MB message and a 16004-byte message from the other:

  ```js
  session.on("data_received", ({ data }) =>
    console.log(typeof data === "string" ? data : data.byteLength));
  await session.sendData(new Uint8Array(1024 * 1024).buffer);
  await session.sendData(new Uint8Array(16004).buffer);
  ```

  The receiving console prints `1048576` and `16004`.
- [ ] The text and binary checks again, with a page built on the v1 `WebRTCAdaptor` on the other side.
- [ ] In `conference.html`, with more participants than video slots (lower them with `await playSession.setMaxVideoTrackCount(2)`): the tile labels change to `<videoLabel>-><trackId>` as `video_track_assignments` arrive, and follow joins and leaves.
- [ ] Pin a participant. In `conference.html` with three participants, in one of them run, with the stream id another participant joined with:

  ```js
  await playSession.setMaxVideoTrackCount(1);
  await playSession.assignVideoTrack("videoTrack0", "<participant id>", true);
  await playSession.requestVideoTrackAssignments();
  ```

  The tile label shows `videoTrack0-><participant id>` and that participant's video, and keeps it while the others talk. `await playSession.assignVideoTrack("videoTrack0", "<participant id>", false)` releases the slot.
- [ ] Stats on the publisher (bytes sent, outgoing bitrate, resolution) and on the viewer (bitrates, resolution, received and decoded frames per second, frames dropped): all filled and moving.

## Sessions

- [ ] `play.html` never asks for camera or microphone permission. Neither does `data-only.html`, as player or as publisher.
- [ ] On `play.html`, watch `session.state` in the console across a 10-second Wi-Fi drop: `"live"`, then `"reconnecting"`, then `"live"`.
- [ ] On `play.html`, while playing, play a second stream into a second element:

  ```js
  const v = Object.assign(document.createElement("video"), { autoplay: true, muted: true });
  document.body.append(v);
  const second = await adaptor.play("<another live id>", { remoteVideo: v }).ready();
  ```

  Both play. `await second.stop()`: the first keeps playing.
- [ ] After `await session.stop()`, `session.state` is `"ended"`, and `await session.sendData("x").catch(e => e.code)` returns `"session_ended"`.
- [ ] On `publish.html` while publishing, `await adaptor.publish(session.streamId).ready().catch(e => e.code)` returns `"streamIdInUse"`.

## Packaging

- [ ] `npm install`, `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
- [ ] `npm pack --dry-run` lists only files under `dist/`, plus `README.md` and `package.json`.
- [ ] `npm run examples`: the pages work against a local server, and `?websocketURL=` selects another server.
- [ ] `./redeploy.sh`: the deployed pages connect to the app they are served from.
