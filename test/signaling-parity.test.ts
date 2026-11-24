import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebRTCClient } from '../src/client/webrtc-client.js';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: any[] = [];
  raw: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  constructor(public url: string) { MockWebSocket.instances.push(this); }
  send(text: string) { this.raw.push(text); this.sent.push(JSON.parse(text)); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.({}); }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  serverSend(obj: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Client over an open mocked socket, with nothing sent yet. */
async function openClient() {
  vi.stubGlobal('WebSocket', MockWebSocket);
  const sdk = new WebRTCClient({ websocketURL: 'wss://x' });
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  ws.open();
  await sdk.ready();
  ws.sent.length = 0; // drop getIceServerConfig
  ws.raw.length = 0;
  return { sdk, ws };
}

describe('signaling parity sends correct commands', () => {
  beforeEach(() => {
    // minimal PC mock
    // @ts-expect-error mock
    global.RTCPeerConnection = vi.fn(() => ({
      addTrack: vi.fn(),
      getSenders: vi.fn(() => []),
      close: vi.fn(),
      onicecandidate: null,
      oniceconnectionstatechange: null,
      ontrack: null,
      createDataChannel: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('toggleVideo/Audio and info APIs send expected payloads', async () => {
    const { sdk, ws } = await openClient();
    const playing = sdk.play('s1').ready();
    await tick();
    ws.serverSend({ command: 'notification', definition: 'play_started', streamId: 's1' });
    const session = await playing;
    ws.sent.length = 0; // drop play

    session.toggleVideo('t1', true);
    session.toggleAudio('t1', false);
    // queries resolve with the server's answer, which this test does not send
    const queries = [
      sdk.getStreamInfo('s1'),
      sdk.getBroadcastObject('s1'),
      sdk.getRoomInfo('roomA', 's1'),
      sdk.getTracks('s1'),
      sdk.getSubtracks('s1', 'role', 0, 10),
      sdk.getSubtrackCount('s1', 'role', 'active'),
      sdk.getSubscriberCount('s1'),
      sdk.getSubscriberList('s1', 0, 5),
    ];
    await tick();
    await session.requestVideoTrackAssignments();
    await session.assignVideoTrack('vId', 'p1', true);
    await session.updateVideoTrackAssignments(0, 10);
    await session.setMaxVideoTrackCount(6);

    const cmds = ws.sent.map(m => m.command);
    expect(cmds).toEqual([
      'toggleVideo',
      'toggleAudio',
      'getStreamInfo',
      'getBroadcastObject',
      'getRoomInfo',
      'getTrackList',
      'getSubtracks',
      'getSubtracksCount',
      'getSubscriberCount',
      'getSubscribers',
      'getVideoTrackAssignmentsCommand',
      'assignVideoTrackCommand',
      'updateVideoTrackAssignmentsCommand',
      'setMaxVideoTrackCountCommand',
    ]);
    sdk.close();
    await Promise.allSettled(queries);
  });
});

// Oracle: the bytes StreamingClient / ConferenceClient sent before they were merged.
const ORACLE = {
  streamingPublish: '{"command":"publish","streamId":"s1","token":"","video":false,"audio":false}',
  streamingPublishToken: '{"command":"publish","streamId":"s1","token":"tok","video":false,"audio":false}',
  conferencePublish: '{"command":"publish","streamId":"s1","token":"","mainTrack":"r1","streamName":"","metaData":"","role":"","subscriberId":"","subscriberCode":"","video":false,"audio":false}',
  conferencePublishAll: '{"command":"publish","streamId":"s1","token":"t","mainTrack":"r1","streamName":"n","metaData":"m","role":"ro","subscriberId":"si","subscriberCode":"sc","video":false,"audio":false}',
  streamingPlay: '{"command":"play","streamId":"v1","token":"","room":"","trackList":[],"subscriberId":"","subscriberCode":"","viewerInfo":"","role":"","userPublishId":"","disableTracksByDefault":false}',
  streamingPlaySelective: '{"command":"play","streamId":"v1","token":"t","room":"r1","trackList":["a"],"subscriberId":"si","subscriberCode":"sc","viewerInfo":"m","role":"ro","userPublishId":"","disableTracksByDefault":true}',
  conferencePlay: '{"command":"play","streamId":"v1","token":"","room":"","trackList":[],"subscriberId":"","subscriberCode":"","viewerInfo":"","role":"","subscriberName":"","userPublishId":"","disableTracksByDefault":false}',
  conferencePlayAll: '{"command":"play","streamId":"v1","token":"t","room":"r1","trackList":["a"],"subscriberId":"si","subscriberCode":"sc","viewerInfo":"m","role":"ro","subscriberName":"sn","userPublishId":"up","disableTracksByDefault":true}',
};

/** Fields ConferenceClient sent as "" when absent and StreamingClient never sent; v1 sends them too. */
const PUBLISH_DEFAULTS = { streamName: '', metaData: '', role: '', subscriberId: '', subscriberCode: '' };

describe('one publish and one play command, as the old clients sent them', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The text of the command that `start` sends. */
  async function commandOf(start: (sdk: WebRTCClient) => Promise<unknown>) {
    const { sdk, ws } = await openClient();
    const pending = start(sdk).catch(() => {});
    await tick();
    sdk.close();
    await pending;
    return ws.raw[0];
  }

  const all = { token: 't', roomId: 'r1', metaData: 'm', role: 'ro', subscriberId: 'si', subscriberCode: 'sc' };

  it('publish with the options ConferenceClient accepted sends its exact bytes', async () => {
    expect(await commandOf((c) => c.publish('s1', { roomId: 'r1', dataOnly: true }).ready())).toBe(ORACLE.conferencePublish);
    const options = { ...all, streamName: 'n', dataOnly: true };
    expect(await commandOf((c) => c.publish('s1', options).ready())).toBe(ORACLE.conferencePublishAll);
  });

  it('play with the options ConferenceClient accepted sends its exact bytes', async () => {
    expect(await commandOf((c) => c.play('v1').ready())).toBe(ORACLE.conferencePlay);
    const options = { ...all, enableTracks: ['a'], subscriberName: 'sn', userPublishId: 'up', disableTracksByDefault: true };
    expect(await commandOf((c) => c.play('v1', options).ready())).toBe(ORACLE.conferencePlayAll);
  });

  it('publish and play with the options StreamingClient accepted add only ConferenceClient defaults', async () => {
    const publish = JSON.parse(await commandOf((c) => c.publish('s1', { dataOnly: true }).ready()));
    expect(publish).toEqual({ ...JSON.parse(ORACLE.streamingPublish), ...PUBLISH_DEFAULTS });
    const withToken = JSON.parse(await commandOf((c) => c.publish('s1', { token: 'tok', dataOnly: true }).ready()));
    expect(withToken).toEqual({ ...JSON.parse(ORACLE.streamingPublishToken), ...PUBLISH_DEFAULTS });

    expect(JSON.parse(await commandOf((c) => c.play('v1').ready()))).toEqual({
      ...JSON.parse(ORACLE.streamingPlay),
      subscriberName: '',
    });
    const options = { ...all, enableTracks: ['a'], disableTracksByDefault: true };
    expect(JSON.parse(await commandOf((c) => c.play('v1', options).ready()))).toEqual({
      ...JSON.parse(ORACLE.streamingPlaySelective),
      subscriberName: '',
    });
  });
});
