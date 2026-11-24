import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebRTCClient } from '../src/client/webrtc-client.js';
import { PlaySession, PublishSession } from '../src/client/session.js';
import { MediaManager } from '../src/core/media-manager.js';
import { SDKError } from '../src/core/errors.js';

// Drives the real transport seam: WebSocketAdaptor -> handleTransportEvent -> ready()/publish()/play().
// No handleTransportEvent injection here on purpose; that is what hid the ready() deadlock.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  /** Connection attempt fails: browsers fire error, then close. */
  fail() {
    this.readyState = MockWebSocket.CLOSED;
    this.onerror?.({});
    this.onclose?.({});
  }
  /** Unexpected close. */
  drop() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }
  /** Deliver a server frame the way a real socket would. */
  serverSend(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

class MockPC {
  static instances: MockPC[] = [];
  config: RTCConfiguration;
  iceConnectionState = 'new';
  onicecandidate: ((ev: any) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((ev: any) => void) | null = null;
  ondatachannel: ((ev: any) => void) | null = null;
  senders: Array<{ track: MediaStreamTrack; replaceTrack: ReturnType<typeof vi.fn> }> = [];
  constructor(config: RTCConfiguration) {
    // copy: the client may mutate its config object later
    this.config = JSON.parse(JSON.stringify(config ?? {}));
    MockPC.instances.push(this);
  }
  getSenders() { return this.senders; }
  addTrack = vi.fn((track: MediaStreamTrack) => {
    const sender = {
      track,
      replaceTrack: vi.fn(async (t: MediaStreamTrack) => { sender.track = t; }),
    };
    this.senders.push(sender);
    return sender;
  });
  close() {}
  createDataChannel() {
    return { send: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  }
  async createOffer() { return { type: 'offer' as const, sdp: 'v=0\n' }; }
  async createAnswer() { return { type: 'answer' as const, sdp: 'v=0\n' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
}

class MockTrack {
  enabled = true;
  onended: (() => void) | null = null;
  stop = vi.fn();
  constructor(public kind: 'audio' | 'video') {}
}
class MockStream {
  constructor(private tracks: MediaStreamTrack[] = []) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  addTrack(t: MediaStreamTrack) { this.tracks.push(t); }
  removeTrack(t: MediaStreamTrack) { this.tracks = this.tracks.filter(x => x !== t); }
}

const streamFor = (c: MediaStreamConstraints) =>
  new MockStream([
    ...(c.video ? [new MockTrack('video') as unknown as MediaStreamTrack] : []),
    ...(c.audio ? [new MockTrack('audio') as unknown as MediaStreamTrack] : []),
  ]);

function stubMedia(getUserMedia: (c: MediaStreamConstraints) => Promise<MockStream>) {
  vi.stubGlobal('MediaStream', MockStream);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(getUserMedia), enumerateDevices: vi.fn(async () => []) },
  });
}

/** Client ready over the mocked socket whose getUserMedia grants camera+mic; publish opens them. */
async function readyPublisher() {
  const acquired: MockStream[] = [];
  stubMedia(async (c) => {
    const s = streamFor(c);
    acquired.push(s);
    return s;
  });
  const client = new WebRTCClient({ websocketURL: 'wss://x', mediaConstraints: { audio: true, video: true } });
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  ws.open();
  await client.ready();
  return { client, ws, acquired };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The server's notification that a stream is live. */
const started = (definition: string, streamId: string) => ({ command: 'notification', definition, streamId });

/** Settled value of a promise, the rejection reason, or 'pending' if it has not settled. */
const outcome = (p: Promise<unknown>) =>
  Promise.race([
    p.then(() => 'resolved', (e: unknown) => e),
    new Promise((r) => setTimeout(() => r('pending'), 20)),
  ]);

/** Live view of a promise's state, for fake-timer tests where outcome()'s timer is faked. */
const watch = (p: Promise<unknown>) => {
  const s: { state: string; error?: unknown } = { state: 'pending' };
  p.then(() => (s.state = 'resolved'), (e) => Object.assign(s, { state: 'rejected', error: e }));
  return s;
};

/** Wait until the socket has sent a command, so we can answer it like a server would. */
async function waitForCommand(ws: MockWebSocket, command: string, streamId?: string, from = 0) {
  for (let i = 0; i < 50; i++) {
    const msg = ws.sent.slice(from).find((m) => m.command === command && (!streamId || m.streamId === streamId));
    if (msg) return msg;
    await tick();
  }
  throw new Error(`command not sent: ${command}`);
}

/** A live publish of `streamId`, answered like the server does. */
async function livePublish(client: WebRTCClient, ws: MockWebSocket, streamId: string, options = {}) {
  const from = ws.sent.length;
  const publishing = client.publish(streamId, options).ready();
  await waitForCommand(ws, 'publish', streamId, from);
  ws.serverSend({ command: 'start', streamId });
  await waitForCommand(ws, 'takeConfiguration', streamId, from);
  ws.serverSend(started('publish_started', streamId));
  return publishing;
}

/** A live play of `streamId`, answered like the server does. */
async function livePlay(client: WebRTCClient, ws: MockWebSocket, streamId: string, options = {}) {
  const from = ws.sent.length;
  const playing = client.play(streamId, options).ready();
  await waitForCommand(ws, 'play', streamId, from);
  ws.serverSend({ command: 'takeConfiguration', streamId, type: 'offer', sdp: 'v=0' });
  await waitForCommand(ws, 'takeConfiguration', streamId, from);
  ws.serverSend(started('play_started', streamId));
  return playing;
}

/** Every stream method of the two sessions fails with `code`, thrown or rejected. */
async function expectEveryStreamMethodToFail(pub: PublishSession, play: PlaySession, code: string) {
  const calls: Array<[string, () => unknown]> = [
    ['sendData', () => pub.sendData('x')],
    ['getStats', () => pub.getStats()],
    ['enableStats', () => pub.enableStats()],
    ['disableStats', () => pub.disableStats()],
    ['changeBandwidth', () => pub.changeBandwidth(600)],
    ['setDegradationPreference', () => pub.setDegradationPreference('balanced')],
    ['updateStreamMetaData', () => pub.updateStreamMetaData('m')],
    ['forceStreamQuality', () => play.forceStreamQuality(720)],
    ['enableTrack', () => play.enableTrack('t', true)],
    ['toggleVideo', () => play.toggleVideo('t', true)],
    ['toggleAudio', () => play.toggleAudio('t', true)],
    ['enableRemoteAudioLevel', () => play.enableRemoteAudioLevel(() => {})],
    ['disableRemoteAudioLevel', () => play.disableRemoteAudioLevel()],
    ['assignVideoTrack', () => play.assignVideoTrack('t', 'p', true)],
    ['updateVideoTrackAssignments', () => play.updateVideoTrackAssignments(0, 5)],
    ['setMaxVideoTrackCount', () => play.setMaxVideoTrackCount(3)],
    ['requestVideoTrackAssignments', () => play.requestVideoTrackAssignments()],
  ];
  for (const [name, call] of calls) {
    let failure: unknown;
    try {
      await call();
    } catch (e) {
      failure = e;
    }
    expect(failure, name).toBeInstanceOf(SDKError);
    expect(failure, name).toMatchObject({ code });
  }
}

describe('ready() lifecycle over the websocket transport', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockPC.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockPC);
    vi.stubGlobal('RTCSessionDescription', function (x: any) { return x; });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves ready() when the socket opens', async () => {
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();

    // waiter registered before the socket is up: this is the deadlock case
    const pending = client.ready();
    ws.open();
    await expect(pending).resolves.toBeUndefined();

    // a later ready() must resolve without any further transport event
    await expect(client.ready()).resolves.toBeUndefined();

    client.close();
  });

  it('sends getIceServerConfig before ready() waiters resolve', async () => {
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    const ws = MockWebSocket.instances[0];

    const pending = client.ready().then(() => ws.sent.map((m) => m.command));
    ws.open();

    await expect(pending).resolves.toContain('getIceServerConfig');

    client.close();
  });

  it('forwards media manager events to client listeners until close()', () => {
    const media = new MediaManager({});
    const client = new WebRTCClient({ websocketURL: 'wss://x', mediaManager: media });
    const errors = vi.fn();
    const paused = vi.fn();
    const shareStopped = vi.fn();
    client.on('error', errors);
    client.on('local_track_paused', paused);
    client.on('screen_share_stopped', shareStopped);

    media.emit('error', { error: 'set_sink_id_failed' });
    media.emit('local_track_paused', { kind: 'audio' });
    media.emit('screen_share_stopped', undefined);
    expect(errors).toHaveBeenCalledWith({ error: 'set_sink_id_failed' });
    expect(paused).toHaveBeenCalledWith({ kind: 'audio' });
    expect(shareStopped).toHaveBeenCalledTimes(1);

    client.close();
    media.emit('error', { error: 'after_close' });
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('applies local track changes to publish peers only', async () => {
    const { client, ws, acquired } = await readyPublisher();

    const publishing = client.publish('pub1').ready();
    await waitForCommand(ws, 'publish');
    ws.serverSend({ command: 'start', streamId: 'pub1' });
    await waitForCommand(ws, 'takeConfiguration');
    ws.serverSend(started('publish_started', 'pub1'));
    await publishing;
    const playing = client.play('play1').ready();
    await waitForCommand(ws, 'play');
    ws.serverSend({ command: 'takeConfiguration', streamId: 'play1', type: 'offer', sdp: 'v=0' });
    for (let i = 0; i < 50 && !ws.sent.some((m) => m.type === 'answer'); i++) await tick();
    ws.serverSend(started('play_started', 'play1'));
    await playing;

    const [pubPc, playPc] = MockPC.instances;
    const audioSender = pubPc.senders.find((s) => s.track.kind === 'audio')!;
    expect(pubPc.addTrack).toHaveBeenCalledTimes(2);

    await client.media.selectAudioInput('mic-2');
    const mic = acquired[acquired.length - 1].getAudioTracks()[0];

    expect(audioSender.replaceTrack).toHaveBeenCalledWith(mic);
    expect(pubPc.addTrack).toHaveBeenCalledTimes(2);
    expect(playPc.addTrack).not.toHaveBeenCalled();
    expect(playPc.senders).toHaveLength(0);

    client.close();
  });

  it('creates no play peer before the offer arrives', async () => {
    const { client } = await readyPublisher();

    const pending = client.play('play1').ready().catch(() => {});
    await client.media.selectAudioInput('mic-2');

    expect(MockPC.instances).toHaveLength(0);

    client.close();
    await pending;
  });
});

describe('ready() outcome', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fastRetry = { websocketURL: 'wss://x', reconnectConfig: { baseMs: 1, jitter: 0 } };

  it('rejects when the socket errors before opening, and a later attempt can still succeed', async () => {
    const client = new WebRTCClient(fastRetry);
    const pending = client.ready();
    MockWebSocket.instances[0].fail();
    expect(await outcome(pending)).toMatchObject({ message: 'WebSocketNotConnected' });

    // the background retry opens a new socket
    await tick();
    expect(MockWebSocket.instances).toHaveLength(2);
    const again = client.ready();
    MockWebSocket.instances[1].open();
    expect(await outcome(again)).toBe('resolved');
    client.close();
  });

  it('rejects when the socket closes before opening', async () => {
    const client = new WebRTCClient(fastRetry);
    const pending = client.ready();
    MockWebSocket.instances[0].drop();
    expect(await outcome(pending)).toMatchObject({ message: 'WebSocketNotConnected' });
    client.close();
  });

  it('rejects after close()', async () => {
    const client = new WebRTCClient(fastRetry);
    const pending = client.ready();
    client.close();
    expect(await outcome(pending)).toMatchObject({ message: 'WebSocketNotConnected' });
    expect(await outcome(client.ready())).toMatchObject({ message: 'WebSocketNotConnected' });
  });

  it('rejects with SDKError', async () => {
    const client = new WebRTCClient(fastRetry);
    const pending = client.ready();
    MockWebSocket.instances[0].fail();
    const failed = await outcome(pending);
    expect(failed).toBeInstanceOf(SDKError);
    expect(failed).toMatchObject({ code: 'WebSocketNotConnected' });
    client.close();
    expect(await outcome(client.ready())).toBeInstanceOf(SDKError);
  });

  it('the constructor throws without websocketURL', () => {
    expect(() => new WebRTCClient({} as never)).toThrow();
  });
});

describe('publish() waits for local media', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockPC.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockPC);
    vi.stubGlobal('RTCSessionDescription', function (x: any) { return x; });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const options of [{}, { roomId: 'r1' }]) {
    it(`publish(${JSON.stringify(options)}) sends nothing until getUserMedia resolves`, async () => {
      let grant!: () => void;
      stubMedia((c) => new Promise((r) => (grant = () => r(streamFor(c)))));
      const client = new WebRTCClient({ websocketURL: 'wss://x', mediaConstraints: { audio: true, video: true } });
      const ws = MockWebSocket.instances[0];
      ws.open();
      await client.ready();

      const pending = client.publish('s1', options).ready().catch(() => {});
      await tick();
      expect(ws.sent.filter((m) => m.command === 'publish')).toHaveLength(0);

      grant();
      await waitForCommand(ws, 'publish');
      expect(ws.sent.filter((m) => m.command === 'publish')).toEqual([
        expect.objectContaining({ streamId: 's1', video: true, audio: true }),
      ]);
      client.close();
      await pending;
    });
  }

  it('constructing and playing never ask for media; the first media publish does, once', async () => {
    const { client, ws } = await readyPublisher();
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    await livePlay(client, ws, 'v1');
    await livePublish(client, ws, 'd1', { dataOnly: true });
    expect(getUserMedia).not.toHaveBeenCalled();

    await livePublish(client, ws, 's1');
    await livePublish(client, ws, 's2');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('a device call before the first publish leaves it both camera and microphone', async () => {
    const { client, ws } = await readyPublisher();
    await client.media.selectAudioInput('mic-2');
    await livePublish(client, ws, 's1');
    expect(ws.sent.find((m) => m.command === 'publish')).toMatchObject({ video: true, audio: true });
    client.close();
  });

  it('a data-only publish sends no media and is left alone by local track changes', async () => {
    const { client, ws } = await readyPublisher();
    await client.media.initLocalStream();
    const session = await livePublish(client, ws, 'd1', { dataOnly: true });
    expect(ws.sent.find((m) => m.command === 'publish')).toMatchObject({ video: false, audio: false });
    const pc = session.peerConnection as unknown as MockPC;
    expect(pc.addTrack).not.toHaveBeenCalled();

    await client.media.selectVideoInput('cam-2');
    await client.media.selectAudioInput('mic-2');
    expect(pc.addTrack).not.toHaveBeenCalled();
    expect(pc.senders).toHaveLength(0);
    client.close();
  });

  it('rejects publish() with the getUserMedia error and sends nothing', async () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    stubMedia(async () => {
      throw denied;
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const errors: unknown[] = [];
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    client.on('error', (e) => errors.push(e));
    const ws = MockWebSocket.instances[0];
    ws.open();
    await client.ready();
    await tick();
    expect(errors).toEqual([]);

    // reported once, named like v1
    const failed = await client.publish('s1').ready().catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(SDKError);
    expect(failed).toMatchObject({ code: 'NotAllowedError', info: denied });
    await tick();
    expect(errors).toEqual([{ error: 'NotAllowedError', message: 'Permission denied' }]);
    expect(ws.sent.filter((m) => m.command === 'publish')).toHaveLength(0);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
    client.close();
  });

  it('maps getUserMedia failures to the v1 error names', async () => {
    for (const name of ['NotFoundError', 'NotReadableError', 'OverconstrainedError']) {
      MockWebSocket.instances = [];
      stubMedia(async () => {
        throw Object.assign(new Error(name), { name });
      });
      const client = new WebRTCClient({ websocketURL: 'wss://x' });
      const errors: Array<{ error: string }> = [];
      client.on('error', (e) => errors.push(e));
      MockWebSocket.instances[0].open();
      await client.publish('s1').ready().catch(() => {});
      expect(errors.map((e) => e.error)).toEqual([name]);
      client.close();
    }
  });

  it('a publish after a denied one asks for media again', async () => {
    let allow = false;
    stubMedia(async (c) => {
      if (!allow) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      return streamFor(c);
    });
    const client = new WebRTCClient({ websocketURL: 'wss://x', mediaConstraints: { audio: true, video: true } });
    client.on('error', () => {});
    const ws = MockWebSocket.instances[0];
    ws.open();
    await client.ready();
    await client.publish('s1').ready().catch(() => {});

    allow = true;
    const pending = client.publish('s1').ready().catch(() => {});
    expect(await waitForCommand(ws, 'publish')).toMatchObject({ video: true, audio: true });
    client.close();
    await pending;
  });

  it('reports a failing startPublishing as an error event, not an unhandled rejection', async () => {
    stubMedia(async (c) => streamFor(c));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    const errors: Array<{ error: string }> = [];
    client.on('error', (e) => errors.push(e));
    const ws = MockWebSocket.instances[0];
    ws.open();
    const pending = client.publish('s1').ready().catch(() => {});
    await waitForCommand(ws, 'publish');
    // the local stream is gone by the time the server asks for the offer
    vi.spyOn(client.media, 'getLocalStream').mockReturnValue(null);
    ws.serverSend({ command: 'start', streamId: 's1' });
    await tick();
    await tick();
    expect(errors.map((e) => e.error)).toEqual(['no_local_stream']);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
    client.close();
    await pending;
  });
});

describe('play peer and ICE servers', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockPC.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockPC);
    vi.stubGlobal('RTCSessionDescription', function (x: any) { return x; });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const turn = {
    command: 'iceServerConfig',
    stunServerUri: 'turn:turn.example:3478',
    turnServerUsername: 'u',
    turnServerCredential: 'c',
  };

  it('creates the play peer on the offer, with the ICE servers from iceServerConfig', async () => {
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    const ws = MockWebSocket.instances[0];
    ws.open();
    await client.ready();

    const playing = client.play('v1').ready().catch(() => {});
    await waitForCommand(ws, 'play');
    expect(MockPC.instances).toHaveLength(0);

    ws.serverSend(turn);
    ws.serverSend({ command: 'takeConfiguration', streamId: 'v1', type: 'offer', sdp: 'v=0' });
    await waitForCommand(ws, 'takeConfiguration');
    expect(MockPC.instances).toHaveLength(1);
    expect(MockPC.instances[0].config.iceServers).toContainEqual({
      urls: 'turn:turn.example:3478',
      username: 'u',
      credential: 'c',
    });
    expect(MockPC.instances[0].ondatachannel).toBeTypeOf('function');
    client.close();
    await playing;
  });

  it('each play renders into its own remoteVideo, and its session exposes that stream', async () => {
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    const ws = MockWebSocket.instances[0];
    ws.open();
    const videos = [{ srcObject: null }, { srcObject: null }] as unknown as HTMLVideoElement[];
    const a = await livePlay(client, ws, 'a', { remoteVideo: videos[0] });
    const b = await livePlay(client, ws, 'b', { remoteVideo: videos[1] });
    const streams = [new MockStream(), new MockStream()];
    MockPC.instances[0].ontrack!({ streams: [streams[0]], track: { id: 'ta' }, transceiver: { mid: '0' } });
    MockPC.instances[1].ontrack!({ streams: [streams[1]], track: { id: 'tb' }, transceiver: { mid: '0' } });

    expect(videos.map((v) => v.srcObject)).toEqual(streams);
    expect([a.stream, b.stream]).toEqual(streams);
    client.close();
    expect(a.stream).toBeNull();
  });

  it('peerConnectionConfig wins over the server ICE config', async () => {
    const mine = { iceServers: [{ urls: 'turn:mine.example', username: 'me', credential: 'x' }] };
    const client = new WebRTCClient({ websocketURL: 'wss://x', peerConnectionConfig: mine });
    const ws = MockWebSocket.instances[0];
    ws.open();
    await client.ready();
    // v1 parity: user-defined ICE servers are not requested from the server
    expect(ws.sent.filter((m) => m.command === 'getIceServerConfig')).toHaveLength(0);

    const playing = client.play('v1').ready().catch(() => {});
    await waitForCommand(ws, 'play');
    ws.serverSend(turn);
    ws.serverSend({ command: 'takeConfiguration', streamId: 'v1', type: 'offer', sdp: 'v=0' });
    await waitForCommand(ws, 'takeConfiguration');
    expect(MockPC.instances[0].config.iceServers).toEqual(mine.iceServers);
    client.close();
    await playing;
  });

  it('peerConnectionConfig without iceServers keeps the default STUN server', async () => {
    const client = new WebRTCClient({
      websocketURL: 'wss://x',
      peerConnectionConfig: { iceTransportPolicy: 'relay' },
    });
    const ws = MockWebSocket.instances[0];
    ws.open();
    const playing = client.play('v1').ready().catch(() => {});
    await waitForCommand(ws, 'play');
    ws.serverSend({ command: 'takeConfiguration', streamId: 'v1', type: 'offer', sdp: 'v=0' });
    await waitForCommand(ws, 'takeConfiguration');
    expect(MockPC.instances[0].config).toEqual({
      iceServers: [{ urls: 'stun:stun1.l.google.com:19302' }],
      iceTransportPolicy: 'relay',
    });
    client.close();
    await playing;
  });
});

describe('protocol and per-stream cleanup', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockPC.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockPC);
    vi.stubGlobal('RTCSessionDescription', function (x: any) { return x; });
    vi.stubGlobal('RTCIceCandidate', function (x: any) { return x; });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('close() emits closed once', async () => {
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    MockWebSocket.instances[0].open();
    await client.ready();
    const closed = vi.fn();
    client.on('closed', closed);
    client.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('a server stop frame sends nothing back', async () => {
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    const ws = MockWebSocket.instances[0];
    ws.open();
    const finished = vi.fn();
    client.on('play_finished', finished);
    await livePlay(client, ws, 'live');
    const starting = client.play('v1');
    await waitForCommand(ws, 'play', 'v1');
    ws.serverSend({ command: 'stop', streamId: 'live' });
    ws.serverSend({ command: 'stop', streamId: 'v1' });
    expect(ws.sent.filter((m) => m.command === 'stop')).toHaveLength(0);
    // it ends a play still waiting for play_started, too, which never started: no finished event
    expect(finished.mock.calls).toEqual([[{ streamId: 'live' }]]);
    await expect(starting.ready()).rejects.toMatchObject({ code: 'stream_stopped' });
    expect(starting.state).toBe('ended');
    client.close();
  });

  it('a failed answer is an error event for its stream, a failed queued candidate is logged', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    const ws = MockWebSocket.instances[0];
    ws.open();
    const errors: unknown[] = [];
    client.on('error', (e) => errors.push(e));
    const starts = ['s1', 's2'].map((id) => client.publish(id, { dataOnly: true }).ready().catch(() => {}));
    await tick();
    ws.serverSend({ command: 'start', streamId: 's1' });
    ws.serverSend({ command: 'start', streamId: 's2' });
    await tick();
    const [pc1, pc2] = MockPC.instances;
    pc1.setRemoteDescription = async () => {
      throw new Error('bad sdp');
    };
    (pc2 as any).addIceCandidate = async () => {
      throw new Error('bad candidate');
    };
    // queued until s2's answer is applied, then flushed
    ws.serverSend({ command: 'takeCandidate', streamId: 's2', label: 0, candidate: 'candidate udp' });
    ws.serverSend({ command: 'takeConfiguration', streamId: 's1', type: 'answer', sdp: 'v=0' });
    ws.serverSend({ command: 'takeConfiguration', streamId: 's2', type: 'answer', sdp: 'v=0' });
    await tick();
    await tick();

    expect(errors).toEqual([{ error: 'notSetRemoteDescription', message: expect.any(Error), streamId: 's1' }]);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
    client.close();
    await Promise.all(starts);
  });

  it('a candidate that cannot be constructed is logged, and the answer still applies', async () => {
    vi.stubGlobal('RTCIceCandidate', function () {
      throw new TypeError('bad candidate');
    });
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    const ws = MockWebSocket.instances[0];
    ws.open();
    const errors: unknown[] = [];
    client.on('error', (e) => errors.push(e));
    const publishing = client.publish('s1', { dataOnly: true }).ready();
    await waitForCommand(ws, 'publish');
    ws.serverSend({ command: 'start', streamId: 's1' });
    await waitForCommand(ws, 'takeConfiguration');
    ws.serverSend({ command: 'takeCandidate', streamId: 's1', label: 0, candidate: 'candidate udp' });
    ws.serverSend({ command: 'takeConfiguration', streamId: 's1', type: 'answer', sdp: 'v=0' });
    await tick();
    expect(errors).toEqual([]);
    ws.serverSend(started('publish_started', 's1'));
    expect(await outcome(publishing)).toBe('resolved');
    client.close();
  });

  it('stop() leaves no per-stream state or timer behind', async () => {
    vi.stubGlobal('AudioContext', vi.fn(() => ({
      close: vi.fn(async () => {}),
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => ({ fftSize: 0, frequencyBinCount: 4, getByteTimeDomainData: vi.fn(), disconnect: vi.fn() }),
    })));
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    const ws = MockWebSocket.instances[0];
    ws.open();
    const playing = client.play('v1').ready();
    await waitForCommand(ws, 'play');
    ws.serverSend({ command: 'takeCandidate', streamId: 'v1', label: 0, candidate: 'candidate udp' });
    ws.serverSend({ command: 'takeConfiguration', streamId: 'v1', type: 'offer', sdp: 'v=0', idMapping: { '0': 't1' } });
    await waitForCommand(ws, 'takeConfiguration');
    ws.serverSend(started('play_started', 'v1'));
    const session = await playing;
    const remote = new MockStream([]);
    MockPC.instances[0].ontrack!({ streams: [remote], track: { id: 'x' }, transceiver: { mid: '0' } });
    // only intervals created from here on are counted
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    session.enableStats(1000);
    await session.enableRemoteAudioLevel(() => {}, 100);
    MockPC.instances[0].iceConnectionState = 'disconnected';
    MockPC.instances[0].oniceconnectionstatechange!();

    void session.stop();

    const c = client as any;
    for (const map of [c.peers, c.activeStreams, c.remoteDescriptionSet, c.candidateQueue, c.remoteStreams,
      c.lastReconnectAt, c.reconnectAttempts, c.reconnectInFlight, c.reconnectTimers, c.remoteMeters]) {
      expect(map.has('v1')).toBe(false);
    }
    expect(c.idMapping.v1).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });
});

describe('publish() and play() resolve when the stream is live', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockPC.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockPC);
    vi.stubGlobal('RTCSessionDescription', function (x: any) { return x; });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Client over an open socket; reconnects after ~1 ms. */
  async function openClient() {
    const client = new WebRTCClient({ websocketURL: 'wss://x', reconnectConfig: { baseMs: 1, jitter: 0 } });
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.open();
    await client.ready();
    return { client, ws };
  }

  /** Data-only, so publish needs no camera. */
  const publish = (client: WebRTCClient, streamId: string) => client.publish(streamId, { dataOnly: true }).ready();

  it('publish() and play() return their session at once; ready() resolves with it once live', async () => {
    const { client, ws } = await openClient();
    const pub = client.publish('s1', { dataOnly: true });
    const view = client.play('v1');
    expect(pub).toBeInstanceOf(PublishSession);
    expect(view).toBeInstanceOf(PlaySession);
    expect([pub.streamId, pub.state, view.streamId, view.state]).toEqual(['s1', 'starting', 'v1', 'starting']);
    const states: string[] = [];
    pub.on('publish_started', () => states.push(pub.state));

    const pending = pub.ready();
    await waitForCommand(ws, 'publish');
    ws.serverSend({ command: 'start', streamId: 's1' });
    await waitForCommand(ws, 'takeConfiguration');
    expect(await outcome(pending)).toBe('pending');
    expect(pub.state).toBe('starting');

    ws.serverSend(started('publish_started', 's1'));
    expect(await pending).toBe(pub);
    // live already for the started event's listeners
    expect(states).toEqual(['live']);
    expect(await pub.ready()).toBe(pub);
    expect(pub.peerConnection).toBe(MockPC.instances[0]);

    ws.serverSend(started('play_started', 'v1'));
    expect(await view.ready()).toBe(view);
    expect(view.state).toBe('live');
    client.close();
    // still how the start went
    expect(await pub.ready()).toBe(pub);
  });

  it('a failed start ends its session with no finished event and no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { client, ws } = await openClient();
    const finished = vi.fn();
    client.on('publish_finished', finished);
    client.on('play_finished', finished);
    // nobody calls ready() on these
    const pub = client.publish('s1', { dataOnly: true });
    const view = client.play('v1');
    pub.on('publish_finished', finished);
    view.on('play_finished', finished);
    await tick();
    ws.serverSend({ command: 'error', definition: 'no_stream_exist', streamId: 's1' });
    ws.serverSend({ command: 'error', definition: 'no_stream_exist', streamId: 'v1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
    expect([pub.state, view.state]).toEqual(['ended', 'ended']);
    expect(finished).not.toHaveBeenCalled();
    await expect(pub.ready()).rejects.toMatchObject({ code: 'no_stream_exist' });
    expect((client as any).activeStreams.size).toBe(0);

    // the id is free again, for a new session
    const again = publish(client, 's1');
    await tick();
    ws.serverSend(started('publish_started', 's1'));
    expect((await again).state).toBe('live');
    client.close();
  });

  it('rejects with the server definition as the code on an error frame for that stream', async () => {
    const { client, ws } = await openClient();
    const s1 = publish(client, 's1');
    const s2 = publish(client, 's2');
    await tick();
    ws.serverSend({ command: 'error', definition: 'unauthorized_access', streamId: 's1' });

    const failed = await outcome(s1);
    expect(failed).toBeInstanceOf(SDKError);
    expect(failed).toMatchObject({ code: 'unauthorized_access' });
    expect(await outcome(s2)).toBe('pending');
    client.close();
  });

  it('an error frame without streamId settles a pending start only when it is the only one', async () => {
    const { client, ws } = await openClient();
    const s1 = publish(client, 's1');
    const s2 = publish(client, 's2');
    await tick();
    ws.serverSend({ command: 'error', definition: 'highResourceUsage' });
    expect(await outcome(s1)).toBe('pending');
    expect(await outcome(s2)).toBe('pending');

    ws.serverSend(started('publish_started', 's2'));
    expect(await outcome(s2)).toBe('resolved');
    ws.serverSend({ command: 'error', definition: 'highResourceUsage' });
    expect(await outcome(s1)).toMatchObject({ code: 'highResourceUsage' });
    client.close();
  });

  it('rejects on timeout and leaves nothing behind, also after a socket reopen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, ws } = await openClient();
    const pending = watch(publish(client, 's1'));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(pending.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.error).toBeInstanceOf(SDKError);
    expect(pending.error).toMatchObject({ code: 'timeout' });

    // cleaned up: the server is told, nothing is active and no timer is left
    expect(ws.sent.filter((m) => m.command === 'stop')).toEqual([{ command: 'stop', streamId: 's1' }]);
    expect((client as any).activeStreams.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    ws.drop();
    await vi.advanceTimersByTimeAsync(10);
    const ws2 = MockWebSocket.instances[1];
    ws2.open();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws2.sent.filter((m) => m.command === 'publish')).toHaveLength(0);
    client.close();
  });

  it('rejects when the socket drops while waiting, and the new socket does not restart it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, ws } = await openClient();
    const pending = watch(publish(client, 's1'));
    await vi.advanceTimersByTimeAsync(0);
    ws.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.error).toBeInstanceOf(SDKError);
    expect(pending.error).toMatchObject({ code: 'WebSocketNotConnected' });

    await vi.advanceTimersByTimeAsync(10);
    const ws2 = MockWebSocket.instances[1];
    ws2.open();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws2.sent.filter((m) => m.command === 'publish')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it('rejects when stop() or close() is called while waiting', async () => {
    const { client } = await openClient();
    const s1 = client.publish('s1', { dataOnly: true });
    const s2 = client.publish('s2', { dataOnly: true });
    await tick();

    void s1.stop();
    expect(await outcome(s1.ready())).toMatchObject({ code: 'stream_stopped' });
    expect(await outcome(s2.ready())).toBe('pending');
    client.close();
    expect(await outcome(s2.ready())).toMatchObject({ code: 'stream_stopped' });
  });

  it('stop() on a starting session cancels it: stop sent, nothing left, no finished event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, ws } = await openClient();
    const finished = vi.fn();
    client.on('publish_finished', finished);
    const session = client.publish('s1', { dataOnly: true });
    session.on('publish_finished', finished);
    await vi.advanceTimersByTimeAsync(0);
    ws.serverSend({ command: 'start', streamId: 's1' });
    await vi.advanceTimersByTimeAsync(0);

    await session.stop();
    await expect(session.ready()).rejects.toMatchObject({ code: 'stream_stopped' });
    expect(session.state).toBe('ended');
    expect(ws.sent.filter((m) => m.command === 'stop')).toEqual([{ command: 'stop', streamId: 's1' }]);
    expect([(client as any).activeStreams.size, (client as any).peers.size]).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
    ws.serverSend(started('publish_started', 's1'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.state).toBe('ended');
    expect(finished).not.toHaveBeenCalled();

    // stopped before its command went out: the command never does
    const early = client.publish('s2', { dataOnly: true });
    ws.drop();
    await early.stop();
    await vi.advanceTimersByTimeAsync(10);
    MockWebSocket.instances[MockWebSocket.instances.length - 1].open();
    await expect(early.ready()).rejects.toMatchObject({ code: 'stream_stopped' });
    expect(MockWebSocket.instances.flatMap((w) => w.sent).filter((m) => m.streamId === 's2')).toEqual([]);
    client.close();
  });

  /** Error events, for the local-failure tests below. */
  function recordErrors(client: WebRTCClient) {
    const errors: unknown[] = [];
    client.on('error', (e) => errors.push(e));
    return errors;
  }

  it('a failed start of publishing rejects publish() at once with its code', async () => {
    stubMedia(async (c) => streamFor(c));
    // media publish whose local stream is gone when the offer is built
    const noStream = await openClient();
    // data-only publish whose offer cannot be created
    const noOffer = await openClient();
    vi.spyOn(MockPC.prototype, 'createOffer').mockRejectedValue(new Error('no offer'));
    const cases = [[noStream, 'no_local_stream', {}], [noOffer, 'notSetLocalDescription', { dataOnly: true }]] as const;
    for (const [{ client, ws }, code, options] of cases) {
      const errors = recordErrors(client);
      const pending = client.publish('s1', options).ready();
      await waitForCommand(ws, 'publish');
      vi.spyOn(client.media, 'getLocalStream').mockReturnValue(null);
      ws.serverSend({ command: 'start', streamId: 's1' });
      const failed = await outcome(pending);
      expect(failed).toBeInstanceOf(SDKError);
      expect(failed).toMatchObject({ code });
      expect(errors).toEqual([{ error: code, message: expect.anything(), streamId: 's1' }]);
      client.close();
    }
  });

  it('a failed remote description on the answer rejects publish() at once', async () => {
    const { client, ws } = await openClient();
    const errors = recordErrors(client);
    const pending = publish(client, 's1');
    await waitForCommand(ws, 'publish');
    ws.serverSend({ command: 'start', streamId: 's1' });
    await waitForCommand(ws, 'takeConfiguration');
    MockPC.instances[0].setRemoteDescription = async () => {
      throw new Error('bad sdp');
    };
    ws.serverSend({ command: 'takeConfiguration', streamId: 's1', type: 'answer', sdp: 'v=0' });
    expect(await outcome(pending)).toMatchObject({ code: 'notSetRemoteDescription' });
    expect(errors).toEqual([{ error: 'notSetRemoteDescription', message: expect.any(Error), streamId: 's1' }]);
    client.close();
  });

  it('a failed remote description on the offer rejects play() at once', async () => {
    const { client, ws } = await openClient();
    const errors = recordErrors(client);
    vi.spyOn(MockPC.prototype, 'setRemoteDescription').mockRejectedValue(new Error('bad sdp'));
    const pending = client.play('v1').ready();
    await waitForCommand(ws, 'play');
    ws.serverSend({ command: 'takeConfiguration', streamId: 'v1', type: 'offer', sdp: 'v=0' });
    expect(await outcome(pending)).toMatchObject({ code: 'notSetRemoteDescription' });
    expect(errors).toEqual([{ error: 'notSetRemoteDescription', message: expect.any(Error), streamId: 'v1' }]);
    client.close();
  });

  it('a start for an id that is already active returns an ended session, leaving the active one alone', async () => {
    const { client, ws } = await openClient();
    const active = client.publish('s1', { dataOnly: true });
    await tick();
    ws.serverSend(started('publish_started', 's1'));
    await active.ready();

    for (const again of [client.publish('s1', { dataOnly: true }), client.play('s1')]) {
      expect(again).not.toBe(active);
      expect(again.state).toBe('ended');
      const failed = await again.ready().catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(SDKError);
      expect(failed).toMatchObject({ code: 'streamIdInUse' });
    }
    expect(ws.sent.filter((m) => m.command === 'publish')).toHaveLength(1);
    expect(ws.sent.filter((m) => m.command === 'stop')).toHaveLength(0);
    expect([active.state, (client as any).activeStreams.get('s1').session]).toEqual(['live', active]);
    client.close();
  });
});

describe('sessions', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockPC.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockPC);
    vi.stubGlobal('RTCSessionDescription', function (x: any) { return x; });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a session receives the events of its own stream only; the client receives all', async () => {
    const { client, ws } = await readyPublisher();
    const a = await livePlay(client, ws, 'a');
    const b = await livePublish(client, ws, 'b', { dataOnly: true });
    const seen: Record<string, string[]> = { a: [], b: [], client: [] };
    const record = (who: string) => (p: { streamId?: string }) => seen[who].push(p.streamId ?? '-');
    a.on('data_received', record('a'));
    b.on('data_received', record('b'));
    client.on('data_received', record('client'));
    const errorsA: unknown[] = [];
    a.on('error', (e) => errorsA.push(e));
    const stats: unknown[] = [];
    a.on('updated_stats', (ps) => stats.push(ps));

    client.emit('data_received', { streamId: 'a', data: '1' });
    client.emit('data_received', { streamId: 'b', data: '2' });
    client.emit('data_received', { streamId: 'other', data: '3' });
    expect(seen).toEqual({ a: ['a'], b: ['b'], client: ['a', 'b', 'other'] });

    const frame = { command: 'error', definition: 'no_stream_exist', streamId: 'a' };
    ws.serverSend(frame);
    ws.serverSend({ ...frame, streamId: 'b' });
    expect(errorsA).toEqual([{ error: 'no_stream_exist', message: frame, streamId: 'a' }]);

    (MockPC.instances[0] as any).getStats = async () => new Map();
    const ps = await a.getStats();
    expect(stats).toEqual([ps]);
    client.close();
  });

  it('one client holds a media publish, a data-only publish and a play at once', async () => {
    const { client, ws } = await readyPublisher();
    const media = await livePublish(client, ws, 'cam');
    const data = await livePublish(client, ws, 'data', { dataOnly: true });
    const view = await livePlay(client, ws, 'view');
    expect(ws.sent.filter((m) => m.command === 'publish').map((m) => [m.streamId, m.video, m.audio])).toEqual([
      ['cam', true, true],
      ['data', false, false],
    ]);
    const [camPc, dataPc, viewPc] = [media, data, view].map((s) => s.peerConnection as unknown as MockPC);
    expect([camPc.senders.length, dataPc.senders.length, viewPc.senders.length]).toEqual([2, 0, 0]);
    expect([media.state, data.state, view.state]).toEqual(['live', 'live', 'live']);
    client.close();
  });

  it('every method of an ended session fails with session_ended, except stop()', async () => {
    const { client, ws } = await readyPublisher();
    const pub = await livePublish(client, ws, 'p', { dataOnly: true });
    const play = await livePlay(client, ws, 'v');
    const stopping = Promise.all([pub.stop(), play.stop()]);
    ws.serverSend(started('publish_finished', 'p'));
    ws.serverSend(started('play_finished', 'v'));
    await stopping;
    expect([pub.state, play.state, pub.peerConnection, play.stream]).toEqual(['ended', 'ended', null, null]);
    const sent = ws.sent.length;

    await expectEveryStreamMethodToFail(pub, play, 'session_ended');
    await expect(pub.stop()).resolves.toBeUndefined();
    await expect(play.stop()).resolves.toBeUndefined();
    expect(ws.sent.length).toBe(sent);
    client.close();
  });

  it('a session that is not live yet fails its stream methods with session_not_live', async () => {
    const { client, ws } = await readyPublisher();
    const pub = client.publish('p', { dataOnly: true });
    const play = client.play('v');
    await waitForCommand(ws, 'play', 'v');
    const sent = ws.sent.length;
    await expectEveryStreamMethodToFail(pub, play, 'session_not_live');
    expect(ws.sent.length).toBe(sent);
    // getters, ready(), on/off and stop() are fine
    expect([pub.state, pub.peerConnection, play.stream]).toEqual(['starting', null, null]);
    const off = play.on('newTrackAvailable', () => {});
    off();
    ws.serverSend(started('play_started', 'v'));
    expect(await play.ready()).toBe(play);
    await play.toggleVideo('t', true);
    await pub.stop();
    expect(pub.state).toBe('ended');
    client.close();
  });

  it('listeners attached right after play() get the events that come before it is live', async () => {
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    const ws = MockWebSocket.instances[0];
    ws.open();
    const room = client.play('room1');
    const seen: string[] = [];
    room.on('newTrackAvailable', ({ trackId }) => seen.push(`track:${trackId}`));
    room.on('data_channel_opened', () => seen.push('data_channel_opened'));
    await waitForCommand(ws, 'play', 'room1');
    ws.serverSend({ command: 'takeConfiguration', streamId: 'room1', type: 'offer', sdp: 'v=0' });
    await waitForCommand(ws, 'takeConfiguration', 'room1');
    const pc = MockPC.instances[0];
    pc.ontrack!({ streams: [new MockStream()], track: { id: 't1' }, transceiver: { mid: '0' } });
    const channel: any = {};
    pc.ondatachannel!({ channel });
    channel.onopen();

    expect(seen).toEqual(['track:t1', 'data_channel_opened']);
    expect(room.state).toBe('starting');
    ws.serverSend(started('play_started', 'room1'));
    expect((await room.ready()).state).toBe('live');
    client.close();
  });

  it('an ended session cannot act on a new session of the same stream id', async () => {
    const { client, ws } = await readyPublisher();
    const old = await livePublish(client, ws, 's1', { dataOnly: true });
    ws.serverSend({ command: 'stop', streamId: 's1' });
    const current = await livePublish(client, ws, 's1', { dataOnly: true });
    const dc = { readyState: 'open', send: vi.fn() };
    // @ts-ignore private: the new peer's open data channel
    client['peers'].get('s1').dc = dc;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stopsBefore = ws.sent.filter((m) => m.command === 'stop').length;

    await expect(old.sendData('x')).rejects.toMatchObject({ code: 'session_ended' });
    expect(() => old.enableStats(10)).toThrow(SDKError);
    expect(() => old.disableStats()).toThrow(SDKError);
    await old.stop();
    expect(dc.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(ws.sent.filter((m) => m.command === 'stop')).toHaveLength(stopsBefore);
    expect([old.state, current.state]).toEqual(['ended', 'live']);

    current.enableStats(10);
    expect(() => old.disableStats()).toThrow(SDKError);
    expect(vi.getTimerCount()).toBe(1);
    await current.sendData('y');
    expect(dc.send).toHaveBeenCalledWith('y');
    client.close();
  });
});
