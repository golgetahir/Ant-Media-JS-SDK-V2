import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebRTCClient } from '../src/client/webrtc-client.js';

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

describe('room and assignments signaling', () => {
  beforeEach(() => {
    // @ts-expect-error mock
    global.WebSocket = vi.fn(() => ({ send: vi.fn(), close: vi.fn(), readyState: 1 }));
  });

  it('joinRoom and leaveRoom send expected payloads', async () => {
    const sdk = new WebRTCClient({ websocketURL: 'ws://x' });
    const sent: string[] = [];
    // @ts-expect-error private
    sdk.ws = { send: (m: string) => sent.push(m), close: vi.fn() } as any;
    // @ts-expect-error private
    sdk.isReady = true;

    await sdk.joinRoom({ roomId: 'r1', streamId: 's1', role: 'publisher', metaData: { a: 1 } });
    await sdk.leaveRoom('r1', 's1');

    const cmds = sent.map(s => JSON.parse(s));
    expect(cmds[0].command).toBe('joinRoom');
    expect(cmds[0].room).toBe('r1');
    expect(cmds[1].command).toBe('leaveFromRoom');
    expect(cmds[1].room).toBe('r1');
  });

  it('assignment signals are formatted correctly', async () => {
    global.WebSocket = MockWebSocket as any;
    const sdk = new WebRTCClient({ websocketURL: 'ws://x' });
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.open();
    const playing = sdk.play('main').ready();
    await new Promise((r) => setTimeout(r, 0));
    ws.serverSend({ command: 'notification', definition: 'play_started', streamId: 'main' });
    const room = await playing;
    ws.sent.length = 0; // drop getIceServerConfig and play
    await room.requestVideoTrackAssignments();
    // pin: streamId is the participant put on the video track, as v1 sends it
    await room.assignVideoTrack('trackA', 'participant1', true);
    await room.updateVideoTrackAssignments(10, 5);
    await room.setMaxVideoTrackCount(9);
    expect(ws.sent).toEqual([
      { command: 'getVideoTrackAssignmentsCommand', streamId: 'main' },
      { command: 'assignVideoTrackCommand', streamId: 'participant1', videoTrackId: 'trackA', enabled: true },
      { command: 'updateVideoTrackAssignmentsCommand', streamId: 'main', offset: 10, size: 5 },
      { command: 'setMaxVideoTrackCountCommand', streamId: 'main', maxTrackCount: 9 },
    ]);
    sdk.close();
  });
});


