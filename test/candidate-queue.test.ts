import { describe, it, expect, vi } from 'vitest';
import { WebRTCClient } from '../src/client/webrtc-client.js';

class MockPC {
  localDescription: any;
  iceConnectionState = 'new';
  onicecandidate: ((ev: any) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: any) => void) | null = null;
  addCount = 0;
  getSenders() { return []; }
  addTrack() {}
  async createAnswer() { return { type: 'answer' as const, sdp: 'v=0\n' }; }
  async setLocalDescription(desc: any) { this.localDescription = desc; }
  async setRemoteDescription() {}
  async addIceCandidate() { this.addCount++; }
}
// @ts-ignore
(global as any).RTCPeerConnection = MockPC;
// @ts-ignore
(global as any).RTCSessionDescription = function (x: any) { return x; };
// @ts-ignore
(global as any).RTCIceCandidate = function (x: any) { return x; };

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


describe('candidate queueing', () => {
  it('queues until remote description set then flushes', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const adaptor = new WebRTCClient({ websocketURL: 'wss://x' });
    const ws = MockWebSocket.instances[0];
    ws.open();

    const playing = adaptor.play('q1').ready().catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    // the offer creates the peer; a candidate right behind it arrives before setRemoteDescription settles
    ws.serverSend({ command: 'takeConfiguration', streamId: 'q1', sdp: 'v=0\n', type: 'offer' });
    ws.serverSend({ command: 'takeCandidate', streamId: 'q1', label: 0, candidate: 'candidate udp 0' });

    await new Promise((r) => setTimeout(r, 0));

    const pc: MockPC = (adaptor as any)['peers'].get('q1').pc;
    expect(pc.addCount).toBe(1);
    adaptor.close();
    await playing;
    vi.unstubAllGlobals();
  });
});
