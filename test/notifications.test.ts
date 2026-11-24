import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebRTCClient } from '../src/client/webrtc-client.js';
import { SDKError } from '../src/core/errors.js';

if (typeof (global as any).MediaStream === 'undefined') {
  (global as any).MediaStream = class {} as any;
}

class MockPC {
  onicecandidate: ((ev: any) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: any) => void) | null = null;
  iceConnectionState = 'new';
  getSenders() { return []; }
  addTrack() {}
  close() {}
  createDataChannel() { return { send() {}, addEventListener() {}, removeEventListener() {} }; }
  async createOffer(){ return { type: 'offer' as const, sdp: 'v=0\n' }; }
  async createAnswer(){ return { type: 'answer' as const, sdp: 'v=0\n' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
}
// @ts-ignore
(global as any).RTCPeerConnection = MockPC;
// @ts-ignore
(global as any).RTCSessionDescription = function(x:any){ return x; };

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
  constructor(public url: string) { MockWebSocket.instances.push(this); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.({}); }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  serverSend(obj: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

/** Client over the mocked socket, opened. */
function openClient(opts: Record<string, unknown> = {}) {
  vi.stubGlobal('WebSocket', MockWebSocket);
  const client = new WebRTCClient({ websocketURL: 'wss://x', ...opts });
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  ws.open();
  return { client, ws };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Data-only publisher whose stream s1 is live, recording publish_finished. */
async function livePublisher() {
  const { client, ws } = openClient();
  const live = client.publish('s1', { dataOnly: true }).ready();
  await tick();
  ws.serverSend({ command: 'notification', definition: 'publish_started', streamId: 's1' });
  const session = await live;
  const finished: string[] = [];
  client.on('publish_finished', ({ streamId }) => finished.push(streamId));
  return { client, ws, finished, session };
}

describe('server notifications are the only source of started/finished', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publish_started fires exactly once, and only from a server notification', async () => {
    const { client: adaptor, ws } = openClient();
    const started: string[] = [];
    adaptor.on('publish_started', ({ streamId }) => started.push(streamId));

    const live = adaptor.publish('s1', { dataOnly: true }).ready();
    await tick();
    // the local offer used to emit publish_started here; it must not
    ws.serverSend({ command: 'start', streamId: 's1' });
    await tick();
    expect(ws.sent.find((m) => m.command === 'takeConfiguration')).toBeTruthy();
    expect(started).toEqual([]);

    ws.serverSend({ command: 'notification', definition: 'publish_started', streamId: 's1' });
    await live;
    expect(started).toEqual(['s1']);
    adaptor.close();
  });

  it('play_started is not emitted when answering the server offer', async () => {
    const { client: adaptor, ws } = openClient();
    const started: string[] = [];
    adaptor.on('play_started', ({ streamId }) => started.push(streamId));

    const live = adaptor.play('v1').ready();
    await tick();
    ws.serverSend({ command: 'takeConfiguration', streamId: 'v1', sdp: 'v=0\n', type: 'offer' });
    await tick();
    expect(ws.sent.find((m) => m.type === 'answer')).toBeTruthy();
    expect(started).toEqual([]);

    ws.serverSend({ command: 'notification', definition: 'play_started', streamId: 'v1' });
    await live;
    expect(started).toEqual(['v1']);
    adaptor.close();
  });
});

describe('stop()', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves on the server publish_finished, which is emitted once, and leaves no timer', async () => {
    const { client, ws, finished, session } = await livePublisher();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolved = false;
    const stopped = session.stop().then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent.filter((m) => m.command === 'stop')).toEqual([{ command: 'stop', streamId: 's1' }]);
    expect(finished).toEqual([]);
    expect(resolved).toBe(false);

    ws.serverSend({ command: 'notification', definition: 'publish_finished', streamId: 's1' });
    await stopped;
    expect(finished).toEqual(['s1']);
    // no dedupe window: nothing hides a later notification
    expect(vi.getTimerCount()).toBe(0);
    ws.serverSend({ command: 'notification', definition: 'publish_finished', streamId: 's2' });
    expect(finished).toEqual(['s1', 's2']);
    client.close();
    expect(finished).toEqual(['s1', 's2']);
  });

  it('resolves at once on an ended session, sending and emitting nothing', async () => {
    const { client, ws, session } = await livePublisher();
    ws.serverSend({ command: 'stop', streamId: 's1' });
    const finished = vi.fn();
    client.on('publish_finished', finished);
    client.on('play_finished', finished);
    let resolved = false;
    void session.stop().then(() => (resolved = true));
    await tick();
    expect(resolved).toBe(true);
    expect(ws.sent.filter((m) => m.command === 'stop')).toEqual([]);
    expect(finished).not.toHaveBeenCalled();
    client.close();
    expect(finished).not.toHaveBeenCalled();
  });

  it('a session gets its finished event exactly once, however it ends, and nothing after it', async () => {
    const ends: Record<string, (c: WebRTCClient, ws: MockWebSocket, s: { stop(): Promise<void> }) => unknown> = {
      'stop(), server answers': async (_c, ws, s) => {
        const stopping = s.stop();
        await tick();
        ws.serverSend({ command: 'notification', definition: 'publish_finished', streamId: 's1' });
        await stopping;
      },
      'stop(), socket down': (_c, ws, s) => {
        ws.close();
        return s.stop();
      },
      'server stop frame': (_c, ws) => ws.serverSend({ command: 'stop', streamId: 's1' }),
      'close()': (c) => c.close(),
    };
    for (const [how, end] of Object.entries(ends)) {
      const { client, ws, session, finished } = await livePublisher();
      const events: string[] = [];
      session.on('publish_finished', () => events.push('publish_finished'));
      session.on('data_received', () => events.push('data_received'));
      session.on('error', () => events.push('error'));
      // the source stopping does not end the session; it hears that too
      ws.serverSend({ command: 'notification', definition: 'publish_finished', streamId: 's1' });
      expect([finished, events, session.state]).toEqual([['s1'], ['publish_finished'], 'live']);
      await end(client, ws, session);
      expect([events, session.state], how).toEqual([['publish_finished', 'publish_finished'], 'ended']);
      // late frames and events about s1
      ws.serverSend({ command: 'notification', definition: 'publish_finished', streamId: 's1' });
      ws.serverSend({ command: 'error', definition: 'no_stream_exist', streamId: 's1' });
      client.emit('data_received', { streamId: 's1', data: 'late' });
      expect(events, how).toEqual(['publish_finished', 'publish_finished']);
      client.close();
    }
  });

  it('the source stops, the session stays and hears play_finished; later stop() delivers one more', async () => {
    const { client, ws } = openClient();
    const live = client.play('v1').ready();
    await tick();
    ws.serverSend({ command: 'notification', definition: 'play_started', streamId: 'v1' });
    const session = await live;
    const events: string[] = [];
    session.on('play_finished', ({ streamId }) => events.push(streamId));

    ws.serverSend({ command: 'notification', definition: 'play_finished', streamId: 'v1' });
    expect([events, session.state]).toEqual([['v1'], 'live']);

    const stopping = session.stop();
    await tick();
    ws.serverSend({ command: 'notification', definition: 'play_finished', streamId: 'v1' });
    await stopping;
    expect([events, session.state]).toEqual([['v1', 'v1'], 'ended']);
    client.close();
    expect(events).toEqual(['v1', 'v1']);
  });

  it('emits locally and resolves at once when the socket is down', async () => {
    const { client, ws, finished, session } = await livePublisher();
    ws.close();
    const before = ws.sent.length;
    await session.stop();
    expect(finished).toEqual(['s1']);
    expect(ws.sent).toHaveLength(before);
    client.close();
  });

  it('resolves after its timeout when the server stays silent, emitting locally once', async () => {
    const { client, finished, session } = await livePublisher();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolved = false;
    void session.stop().then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(finished).toEqual([]);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    expect(finished).toEqual(['s1']);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
    expect(finished).toEqual(['s1']);
  });
});

describe('server error frames', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reach the app as { error: definition, message: frame, streamId }', () => {
    const { client, ws } = openClient();
    const errors: unknown[] = [];
    client.on('error', (e) => errors.push(e));
    const frame = { command: 'error', definition: 'no_stream_exist', streamId: 's1' };
    ws.serverSend(frame);
    expect(errors).toEqual([{ error: 'no_stream_exist', message: frame, streamId: 's1' }]);
    client.close();
  });
});

describe('queries resolve with the server response', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // response shapes as WebSocketEnterpriseHandler sends them
  const queries: Array<[string, (c: WebRTCClient) => Promise<unknown>, Record<string, unknown>]> = [
    ['stream_information', (c) => c.getStreamInfo('s1'), { command: 'streamInformation', streamId: 's1', streamInfo: [] }],
    ['broadcast_object', (c) => c.getBroadcastObject('s1'), { command: 'notification', definition: 'broadcastObject', streamId: 's1', broadcast: '{}' }],
    ['subscriber_count', (c) => c.getSubscriberCount('s1'), { command: 'notification', definition: 'subscriberCount', streamId: 's1', count: 3 }],
    ['subscriber_list', (c) => c.getSubscriberList('s1'), { command: 'notification', definition: 'subscriberList', streamId: 's1', subscriberList: [] }],
    ['track_list', (c) => c.getTracks('s1'), { command: 'trackList', streamId: 's1', trackList: ['t1'] }],
    ['subtrack_list', (c) => c.getSubtracks('s1'), { command: 'notification', definition: 'subtrackList', streamId: 's1', subtrackList: [] }],
    ['subtrack_count', (c) => c.getSubtrackCount('s1'), { command: 'notification', definition: 'subtrackCount', mainTrack: 's1', count: 2 }],
    ['room_information', (c) => c.getRoomInfo('r1'), { command: 'roomInformation', room: 'r1', streams: [], streamList: [] }],
  ];

  it('each query resolves with its response, and its event still fires', async () => {
    const { client, ws } = openClient();
    for (const [event, query, response] of queries) {
      const seen = vi.fn();
      client.on(event as 'track_list', seen);
      const pending = query(client);
      await tick();
      // an answer about another stream does not settle it
      ws.serverSend({ ...response, streamId: 'other', mainTrack: 'other', room: 'other' });
      ws.serverSend(response);
      expect(await pending, event).toEqual(response);
      expect(seen, event).toHaveBeenLastCalledWith(response);
    }
    client.close();
  });

  it('a server error for that stream rejects the query, so does the timeout', async () => {
    const { client, ws } = openClient();
    const info = client.getStreamInfo('s1').catch((e: unknown) => e);
    await tick();
    ws.serverSend({ command: 'error', definition: 'no_stream_exist', streamId: 's1' });
    const failed = await info;
    expect(failed).toBeInstanceOf(SDKError);
    expect(failed).toMatchObject({ code: 'no_stream_exist' });

    // room errors name the room, not a stream
    const room = client.getRoomInfo('r1').catch((e: unknown) => e);
    await tick();
    ws.serverSend({ command: 'error', definition: 'no_active_streams_in_room', room: 'r1' });
    expect(await room).toMatchObject({ code: 'no_active_streams_in_room' });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const count = client.getSubscriberCount('s1').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await count).toMatchObject({ code: 'timeout' });
    client.close();
  });
});

describe('server frames that are top-level commands, not notification definitions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // roomInformation / streamInformation / trackList arrive as {"command":"roomInformation",...}
  // (WebSocketCommunityHandler.sendRoomInformation, WebSocketEnterpriseHandler:1799/2862),
  // so keying them off `definition` never matched.
  it('routes roomInformation, streamInformation and trackList to named events', () => {
    const { client: adaptor, ws } = openClient();
    const seen: Record<string, unknown> = {};
    adaptor.on('room_information', p => (seen.room = p));
    adaptor.on('stream_information', p => (seen.stream = p));
    adaptor.on('track_list', p => (seen.tracks = p));

    ws.serverSend({ command: 'roomInformation', room: 'r1', streams: ['a'], streamList: [{ streamId: 'a' }] });
    ws.serverSend({ command: 'streamInformation', streamId: 's1', streamInfo: [{ streamHeight: 720 }] });
    ws.serverSend({ command: 'trackList', streamId: 's1', trackList: ['t1'] });

    expect((seen.room as any).room).toBe('r1');
    expect((seen.stream as any).streamInfo[0].streamHeight).toBe(720);
    expect((seen.tracks as any).trackList).toEqual(['t1']);
  });

  // server constant is LEAVED_THE_ROOM = "leavedFromRoom" (WebSocketConstants.java:120)
  it('emits room_left for the leavedFromRoom definition the server actually sends', () => {
    const { client: adaptor, ws } = openClient();
    const left: unknown[] = [];
    adaptor.on('room_left', p => left.push(p));

    ws.serverSend({ command: 'notification', definition: 'leavedFromRoom', ATTR_ROOM_NAME: 'r1' });
    expect(left).toHaveLength(1);

    // the older spelling is still accepted
    ws.serverSend({ command: 'notification', definition: 'leavedTheRoom', ATTR_ROOM_NAME: 'r1' });
    expect(left).toHaveLength(2);
  });
});

describe('notifications mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps server notifications and closed/server_will_stop', async () => {
    const { client: adaptor, ws } = openClient({ mediaConstraints: { video: false, audio: false } });
    const events: string[] = [];
    adaptor.on('publish_started', () => events.push('publish_started'));
    adaptor.on('publish_finished', () => events.push('publish_finished'));
    adaptor.on('play_started', () => events.push('play_started'));
    adaptor.on('play_finished', () => events.push('play_finished'));
    adaptor.on('closed', () => events.push('closed'));
    adaptor.on('server_will_stop', () => events.push('server_will_stop'));
    adaptor.on('notification:subscriberCount' as any, () => events.push('notif:subscriberCount'));
    adaptor.on('subscriber_count' as any, () => events.push('evt:subscriber_count'));

    const notify = (definition: string) => ws.serverSend({ command: 'notification', definition, streamId: 's' });
    notify('publish_started');
    notify('publish_finished');
    notify('play_started');
    notify('play_finished');
    // dynamic
    notify('subscriberCount');
    // v1 parity: the client drops the socket, which the app sees as closed
    ws.serverSend({ command: 'notification', definition: 'server_will_stop' });

    expect(events).toEqual([
      'publish_started',
      'publish_finished',
      'play_started',
      'play_finished',
      'evt:subscriber_count',
      'notif:subscriberCount',
      'server_will_stop',
      'closed',
    ]);
    adaptor.close();
  });
});


