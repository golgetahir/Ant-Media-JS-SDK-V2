import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebRTCClient } from '../src/client/webrtc-client.js';

if (typeof (global as any).MediaStream === 'undefined') {
  (global as any).MediaStream = class {} as any;
}

/** Socket mock driven like a server would: open(), serverSend(), drop(). */
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
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  serverSend(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  /** Failed connection: browsers fire error, then close. */
  fail() {
    this.readyState = MockWebSocket.CLOSED;
    this.onerror?.({});
    this.onclose?.({});
  }
  /** Unexpected close, as when the network or server goes away. */
  drop() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }
}

class MockPC {
  static instances: MockPC[] = [];
  localDescription: any;
  iceConnectionState = 'new';
  onicecandidate: ((ev: any) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((ev: any) => void) | null = null;
  ondatachannel: ((ev: any) => void) | null = null;
  senders: Array<{ track: unknown; params: any; getParameters(): any; setParameters(p: any): Promise<void> }> = [];
  constructor() { MockPC.instances.push(this); }
  getSenders() { return this.senders; }
  addTrack(track: unknown) {
    const sender = {
      track,
      params: { encodings: [{}] } as any,
      getParameters() { return this.params; },
      async setParameters(p: any) { this.params = p; },
    };
    this.senders.push(sender);
    return sender;
  }
  createDataChannel() { return { send: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }; }
  async createOffer() { return { type: 'offer' as const, sdp: 'v=0\n' }; }
  async createAnswer() { return { type: 'answer' as const, sdp: 'v=0\n' }; }
  async setLocalDescription(desc: any) { this.localDescription = desc; }
  async setRemoteDescription() {}
  close() { this.iceConnectionState = 'closed'; }
}

const lastWs = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];
const cmds = (ws: MockWebSocket, command: string) => ws.sent.filter(m => m.command === command);

/** Client over the mocked socket, opened, with a deterministic (jitter-free) backoff. */
async function makeClient(opts: { autoReconnect?: boolean } = {}) {
  const client = new WebRTCClient({
    websocketURL: 'wss://x',
    autoReconnect: opts.autoReconnect ?? true,
    reconnectConfig: { backoff: 'exp', baseMs: 500, maxMs: 8000, jitter: 0 },
  });
  const ws = lastWs();
  ws.open();
  await client.ready();
  return { client, ws, sent: ws.sent };
}

/** Drive the peer for a stream into an ICE state and fire its handler. */
function setIce(client: WebRTCClient, streamId: string, state: string) {
  // @ts-ignore private
  const ctx = client['peers'].get(streamId);
  if (!ctx) throw new Error(`no peer for ${streamId}`);
  ctx.pc.iceConnectionState = state;
  ctx.pc.oniceconnectionstatechange?.();
}

/** Publish (data-only by default) + server "start" and publish_started: a live session with a peer connection. */
async function publishAndStart(client: WebRTCClient, ws: MockWebSocket, streamId: string, options = { dataOnly: true }) {
  const live = client.publish(streamId, options).ready();
  await vi.advanceTimersByTimeAsync(0);
  ws.serverSend({ command: 'start', streamId });
  ws.serverSend({ command: 'notification', definition: 'publish_started', streamId });
  const session = await live;
  await vi.advanceTimersByTimeAsync(0);
  return session;
}

describe('auto reconnect', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockPC.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockPC);
    vi.stubGlobal('RTCSessionDescription', function (x: any) { return x; });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('schedules reconnect on ice failed and republishes', async () => {
    const { client, ws, sent } = await makeClient();
    await publishAndStart(client, ws, 's1');
    expect(sent.filter(m => m.command === 'publish')).toHaveLength(1);

    setIce(client, 's1', 'failed');
    // first backoff step is baseMs, then 500ms before the actual republish
    await vi.advanceTimersByTimeAsync(500 + 500);

    expect(sent.filter(m => m.command === 'publish').length).toBeGreaterThanOrEqual(2);
  });

  it('cancels a pending reconnect when ice recovers, and emits reconnected once', async () => {
    const { client, ws, sent } = await makeClient();
    await publishAndStart(client, ws, 's1');

    const finished: string[] = [];
    const recovered: string[] = [];
    client.on('publish_finished', ({ streamId }) => finished.push(streamId));
    client.on('reconnected', ({ streamId }) => recovered.push(streamId));

    setIce(client, 's1', 'disconnected');
    // @ts-ignore private
    expect(client['reconnectTimers'].has('s1')).toBe(true);

    // ICE heals before the scheduled teardown runs
    await vi.advanceTimersByTimeAsync(200);
    setIce(client, 's1', 'connected');

    // @ts-ignore private
    expect(client['reconnectTimers'].has('s1')).toBe(false);
    expect(recovered).toEqual(['s1']);

    // nothing tears the stream down afterwards
    await vi.advanceTimersByTimeAsync(10000);
    expect(sent.filter(m => m.command === 'stop')).toHaveLength(0);
    expect(finished).toEqual([]);
    expect(sent.filter(m => m.command === 'publish')).toHaveLength(1);
    expect(recovered).toEqual(['s1']);
  });

  it('does not tear down a stream that healed by the time the timer fires', async () => {
    const { client, ws, sent } = await makeClient();
    await publishAndStart(client, ws, 's1');

    // schedule a reconnect, then heal the pc silently (no state-change event)
    setIce(client, 's1', 'failed');
    // @ts-ignore private
    client['peers'].get('s1')!.pc.iceConnectionState = 'connected';

    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.filter(m => m.command === 'stop')).toHaveLength(0);
    expect(sent.filter(m => m.command === 'publish')).toHaveLength(1);
  });

  it('grows the backoff delay across consecutive failed restarts', async () => {
    const { client, ws, sent } = await makeClient();
    await publishAndStart(client, ws, 's1');

    const publishCount = () => sent.filter(m => m.command === 'publish').length;
    setIce(client, 's1', 'failed');
    // first attempt: baseMs, then 500ms before the actual republish
    await vi.advanceTimersByTimeAsync(999);
    expect(publishCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishCount()).toBe(2);

    // the server never answers: the watchdog retries at max(3000, baseMs * 2^N), plus 500ms
    for (const delay of [3000, 3000, 4000, 8000]) {
      const before = publishCount();
      await vi.advanceTimersByTimeAsync(delay + 500 - 1);
      expect(publishCount()).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(publishCount()).toBe(before + 1);
    }
  });

  it('a user stop() resets the backoff', async () => {
    const { client, ws } = await makeClient();
    const session = await publishAndStart(client, ws, 's1');

    setIce(client, 's1', 'failed');
    // @ts-ignore private
    expect(client['reconnectAttempts'].get('s1')).toBe(1);

    void session.stop();
    // @ts-ignore private
    expect(client['reconnectAttempts'].has('s1')).toBe(false);
    // @ts-ignore private
    expect(client['reconnectTimers'].has('s1')).toBe(false);
  });
});

describe('websocket reconnect', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockPC.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockPC);
    vi.stubGlobal('RTCSessionDescription', function (x: any) { return x; });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens a new socket after the backoff delay when the socket drops', async () => {
    const { client, ws } = await makeClient();
    const closed = vi.fn();
    client.on('closed', closed);

    ws.drop();
    expect(closed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    // a failed attempt backs off further: 1000ms
    lastWs().drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // a successful open resets the backoff
    lastWs().open();
    lastWs().drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(MockWebSocket.instances).toHaveLength(4);
    client.close();
  });

  it('does not reopen after close()', async () => {
    const { client, ws } = await makeClient();
    client.close();
    ws.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not reopen with autoReconnect: false', async () => {
    const { ws } = await makeClient({ autoReconnect: false });
    ws.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('with autoReconnect: false, publish() opens a new socket and ready() reports its failure', async () => {
    const { client, ws } = await makeClient({ autoReconnect: false });
    ws.drop();

    const pending = client.publish('s1', { dataOnly: true }).ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWebSocket.instances).toHaveLength(2);
    lastWs().open();
    await vi.advanceTimersByTimeAsync(0);
    lastWs().serverSend({ command: 'notification', definition: 'publish_started', streamId: 's1' });
    await pending;
    expect(cmds(lastWs(), 'publish')).toHaveLength(1);

    lastWs().drop();
    const ready = client.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWebSocket.instances).toHaveLength(3);
    lastWs().fail();
    await expect(ready).rejects.toThrow('WebSocketNotConnected');
    client.close();
  });

  it('a failed send between attempts does not reject a pending ready()', async () => {
    const { client, ws } = await makeClient();
    ws.drop();
    let state = 'pending';
    client.ready().then(() => (state = 'resolved'), () => (state = 'rejected'));
    // socket is down, reconnect scheduled: this send fails
    client.registerPushNotificationToken('sub1', 'jwt', 'push-token', 'fcm');
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toBe('pending');

    await vi.advanceTimersByTimeAsync(500);
    lastWs().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toBe('resolved');
    client.close();
  });

  it('a failed send reports only the command name, and does not touch the closed socket', async () => {
    const { client, ws } = await makeClient();
    const errors: unknown[] = [];
    client.on('error', (e) => errors.push(e));
    ws.drop();
    const before = ws.sent.length;

    client.registerPushNotificationToken('sub1', 'secret-jwt', 'push-token', 'fcm');
    expect(errors).toEqual([
      { error: 'WebSocketNotConnected', message: { command: 'registerPushNotificationToken' } },
    ]);
    expect(JSON.stringify(errors)).not.toContain('secret-jwt');
    expect(ws.sent).toHaveLength(before);
    client.close();
  });

  it('a recovery restart creates no pending start: a silent or failing server does not end the stream', async () => {
    const { client, ws } = await makeClient();
    await publishAndStart(client, ws, 's1');
    setIce(client, 's1', 'failed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(cmds(ws, 'publish')).toHaveLength(2);

    // a pending start would reject here and tear the stream down
    ws.serverSend({ command: 'error', definition: 'already_publishing', streamId: 's1' });
    // ...or time out after 15 s and stop the watchdog
    await vi.advanceTimersByTimeAsync(20_000);
    expect(cmds(ws, 'publish').length).toBeGreaterThan(3);
    // @ts-ignore private
    expect(client['activeStreams'].has('s1')).toBe(true);
    client.close();
  });

  it('a recovery announces one attempt and one reconnected', async () => {
    const { client, ws } = await makeClient();
    const events: string[] = [];
    client.on('reconnection_attempt_for_publisher', ({ streamId }) => events.push(`attempt:${streamId}`));
    client.on('reconnected', ({ streamId }) => events.push(`reconnected:${streamId}`));
    await publishAndStart(client, ws, 'p1');
    setIce(client, 'p1', 'connected');

    ws.drop();
    await vi.advanceTimersByTimeAsync(500);
    lastWs().open();
    await vi.advanceTimersByTimeAsync(1000);
    lastWs().serverSend({ command: 'start', streamId: 'p1' });
    await vi.advanceTimersByTimeAsync(0);
    setIce(client, 'p1', 'connected');

    expect(events).toEqual(['attempt:p1', 'reconnected:p1']);
    client.close();
  });

  it('socket loss announces the recovery of each live stream at once, and only once', async () => {
    const { client, ws } = await makeClient();
    const session = await publishAndStart(client, ws, 'p1');
    setIce(client, 'p1', 'connected');
    const starting = client.publish('p2', { dataOnly: true });
    await vi.advanceTimersByTimeAsync(0);
    const events: string[] = [];
    session.on('reconnection_attempt_for_publisher', () => events.push(`attempt:${session.state}`));
    session.on('reconnected', () => events.push(`reconnected:${session.state}`));
    starting.on('reconnection_attempt_for_publisher', () => events.push('attempt:p2'));

    ws.drop();
    expect(events).toEqual(['attempt:reconnecting']);
    // a start in flight fails with the socket, as before
    await expect(starting.ready()).rejects.toMatchObject({ code: 'WebSocketNotConnected' });

    await vi.advanceTimersByTimeAsync(500);
    lastWs().open();
    await vi.advanceTimersByTimeAsync(1000);
    lastWs().serverSend({ command: 'start', streamId: 'p1' });
    await vi.advanceTimersByTimeAsync(0);
    setIce(client, 'p1', 'connected');
    expect(events).toEqual(['attempt:reconnecting', 'reconnected:live']);
    client.close();
  });

  it('abandons a connection attempt that has not opened in 10 seconds, and retries', async () => {
    const client = new WebRTCClient({
      websocketURL: 'wss://x',
      reconnectConfig: { backoff: 'exp', baseMs: 500, maxMs: 8000, jitter: 0 },
    });
    let outcome: string | undefined;
    client.ready().then(() => (outcome = 'open'), e => (outcome = e.code));
    const closed = vi.fn();
    client.on('closed', closed);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('WebSocketNotConnected');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);

    await vi.advanceTimersByTimeAsync(500);
    expect(MockWebSocket.instances).toHaveLength(2);
    lastWs().open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closed).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('close() while a reconnect is scheduled leaves no timer behind', async () => {
    const { client, ws } = await makeClient();
    await publishAndStart(client, ws, 's1');
    setIce(client, 's1', 'failed');
    ws.drop();

    client.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('server_will_stop drops the socket and opens a new one', async () => {
    const { client, ws } = await makeClient();
    const events: string[] = [];
    client.on('server_will_stop', () => events.push('server_will_stop'));
    client.on('closed', () => events.push('closed'));

    // sendServerWillCloseMessage: a notification definition, not a command
    ws.serverSend({ command: 'notification', definition: 'server_will_stop' });
    expect(events).toEqual(['server_will_stop', 'closed']);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);

    await vi.advanceTimersByTimeAsync(500);
    expect(MockWebSocket.instances).toHaveLength(2);
    lastWs().open();
    await expect(client.ready()).resolves.toBeUndefined();
    client.close();
  });

  it('restarts active publish and play on the new socket and emits reconnected', async () => {
    const { client, ws } = await makeClient();
    const finished: string[] = [];
    const recovered: string[] = [];
    client.on('publish_finished', ({ streamId }) => finished.push(streamId));
    client.on('play_finished', ({ streamId }) => finished.push(streamId));
    client.on('reconnected', ({ streamId }) => recovered.push(streamId));

    await publishAndStart(client, ws, 'p1');
    const playing = client.play('v1').ready();
    await vi.advanceTimersByTimeAsync(0);
    ws.serverSend({ command: 'takeConfiguration', streamId: 'v1', type: 'offer', sdp: 'v=0' });
    ws.serverSend({ command: 'notification', definition: 'play_started', streamId: 'v1' });
    await playing;
    await vi.advanceTimersByTimeAsync(0);
    setIce(client, 'p1', 'connected');
    setIce(client, 'v1', 'connected');

    ws.drop();
    await vi.advanceTimersByTimeAsync(500);
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws);
    ws2.open();
    // force path: backoff step, then the 500ms restart delay
    await vi.advanceTimersByTimeAsync(1000);

    expect(cmds(ws2, 'publish').map(m => m.streamId)).toEqual(['p1']);
    expect(cmds(ws2, 'play').map(m => m.streamId)).toEqual(['v1']);

    // server answers the restart; the new peers connect
    ws2.serverSend({ command: 'start', streamId: 'p1' });
    ws2.serverSend({ command: 'takeConfiguration', streamId: 'v1', type: 'offer', sdp: 'v=0' });
    await vi.advanceTimersByTimeAsync(0);
    setIce(client, 'p1', 'connected');
    setIce(client, 'v1', 'connected');

    expect(recovered.sort()).toEqual(['p1', 'v1']);
    expect(finished).toEqual([]);
    client.close();
  });

  it('retries a restart that does not reach ICE connected, until the user stops', async () => {
    const { client, ws, sent } = await makeClient();
    const session = await publishAndStart(client, ws, 's1');
    setIce(client, 's1', 'failed');
    // backoff 500 + restart 500: first republish
    await vi.advanceTimersByTimeAsync(1000);
    expect(cmds(ws, 'publish')).toHaveLength(2);

    // the server never answers: the watchdog restarts again
    await vi.advanceTimersByTimeAsync(3000 + 500);
    expect(cmds(ws, 'publish')).toHaveLength(3);

    void session.stop();
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cmds(ws, 'publish')).toHaveLength(3);
    expect(sent.slice(count).filter(m => m.command !== 'ping')).toEqual([]);
  });

  it('keeps publish_finished from the app during a recovery, also from the server', async () => {
    const { client, ws } = await makeClient();
    const finished: string[] = [];
    client.on('publish_finished', ({ streamId }) => finished.push(streamId));
    await publishAndStart(client, ws, 's1');

    setIce(client, 's1', 'failed');
    await vi.advanceTimersByTimeAsync(500);
    // the recovery teardown told the server; it answers with its own notification
    expect(cmds(ws, 'stop')).toHaveLength(1);
    ws.serverSend({ command: 'notification', definition: 'publish_finished', streamId: 's1' });
    await vi.advanceTimersByTimeAsync(500);

    expect(cmds(ws, 'publish')).toHaveLength(2);
    expect(finished).toEqual([]);
    client.close();
  });

  /** A live publish of one video track, sent by a sender whose parameters the test reads. */
  async function publishVideo(client: WebRTCClient, ws: MockWebSocket) {
    const video = { kind: 'video' };
    const stream = { getTracks: () => [video], getVideoTracks: () => [video], getAudioTracks: () => [] };
    vi.spyOn(client.media, 'getLocalStream').mockReturnValue(stream as unknown as MediaStream);
    return publishAndStart(client, ws, 's1', { dataOnly: false });
  }

  it('changeBandwidth on a sender that reports no encodings sets the cap on a new one', async () => {
    const { client, ws } = await makeClient();
    const session = await publishVideo(client, ws);
    const sender = MockPC.instances[0].senders[0];
    sender.params = { encodings: [] };
    await session.changeBandwidth(300);
    expect(sender.params).toEqual({ encodings: [{ maxBitrate: 300_000 }] });
    client.close();
  });

  it('applies the last changeBandwidth and setDegradationPreference to the recovered peer', async () => {
    const { client, ws } = await makeClient();
    const session = await publishVideo(client, ws);
    await session.changeBandwidth(300);
    await session.changeBandwidth(500);
    await session.setDegradationPreference('maintain-resolution');
    const applied = { encodings: [{ maxBitrate: 500_000 }], degradationPreference: 'maintain-resolution' };
    expect(MockPC.instances[0].senders[0].params).toEqual(applied);

    setIce(client, 's1', 'failed');
    await vi.advanceTimersByTimeAsync(1000);
    ws.serverSend({ command: 'start', streamId: 's1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(MockPC.instances).toHaveLength(2);
    expect(MockPC.instances[1].senders[0].params).toEqual(applied);
    client.close();
  });

  it('stop() inside the 500ms restart window does not republish', async () => {
    const { client, ws } = await makeClient();
    const session = await publishAndStart(client, ws, 's1');
    setIce(client, 's1', 'failed');
    // backoff elapsed: torn down, restart pending
    await vi.advanceTimersByTimeAsync(500);
    void session.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cmds(ws, 'publish')).toHaveLength(1);
  });

  it('session state follows a recovery, and the same session survives a socket reopen', async () => {
    const { client, ws } = await makeClient();
    const session = await publishAndStart(client, ws, 's1');
    setIce(client, 's1', 'connected');
    expect(session.state).toBe('live');
    const attemptStates: string[] = [];
    session.on('reconnection_attempt_for_publisher', () => attemptStates.push(session.state));

    // ICE recovery
    setIce(client, 's1', 'failed');
    expect(attemptStates).toEqual(['reconnecting']);
    expect(session.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    ws.serverSend({ command: 'start', streamId: 's1' });
    await vi.advanceTimersByTimeAsync(0);
    setIce(client, 's1', 'connected');
    expect(session.state).toBe('live');

    // socket recovery: the restarted stream is still this session
    const seen: string[] = [];
    session.on('reconnected', ({ streamId }) => seen.push(streamId));
    ws.drop();
    expect(session.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    lastWs().open();
    expect(session.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    lastWs().serverSend({ command: 'start', streamId: 's1' });
    await vi.advanceTimersByTimeAsync(0);
    setIce(client, 's1', 'connected');
    expect(attemptStates).toEqual(['reconnecting', 'reconnecting']);
    expect(seen).toEqual(['s1']);
    expect(session.state).toBe('live');
    // @ts-ignore private
    expect(client['activeStreams'].get('s1').session).toBe(session);

    void session.stop();
    expect(session.state).toBe('ended');
    client.close();
  });

  it('session state is ended after a server stop frame and after close()', async () => {
    const { client, ws } = await makeClient();
    const a = await publishAndStart(client, ws, 'a');
    const b = await publishAndStart(client, ws, 'b');
    ws.serverSend({ command: 'stop', streamId: 'a' });
    expect([a.state, b.state]).toEqual(['ended', 'live']);
    client.close();
    expect(b.state).toBe('ended');
  });

  it('close() inside the 500ms restart window does not republish', async () => {
    const { client, ws } = await makeClient();
    await publishAndStart(client, ws, 's1');
    setIce(client, 's1', 'failed');
    await vi.advanceTimersByTimeAsync(500);
    client.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cmds(ws, 'publish')).toHaveLength(1);
  });
});
