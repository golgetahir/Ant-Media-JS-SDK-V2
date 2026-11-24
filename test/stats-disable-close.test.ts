import { describe, it, expect, vi } from 'vitest';
import { WebRTCClient } from '../src/client/webrtc-client.js';
import { MediaManager } from '../src/core/media-manager.js';

if (typeof (global as any).MediaStream === 'undefined') {
  (global as any).MediaStream = class {} as any;
}

class MockPC {
  onicecandidate: ((ev: any) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  getSenders() { return []; }
  addTrack() {}
}
// @ts-ignore
(global as any).RTCPeerConnection = MockPC;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  static last: MockWebSocket;
  constructor() { MockWebSocket.last = this; }
  send() {}
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.({}); }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
}

describe('disableStats and close', () => {
  it('stops stats timer and emits closed on close()', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const adaptor = new WebRTCClient({ websocketURL: 'wss://x' });
    MockWebSocket.last.open();

    // install a dummy timer
    adaptor.enableStats('s1', 10);
    adaptor.disableStats('s1');
    // @ts-ignore check private map
    expect(adaptor['statsTimers'].has('s1')).toBe(false);

    let sawClosed = false;
    adaptor.on('closed', () => { sawClosed = true; });
    adaptor.close();
    expect(sawClosed).toBe(true);
    vi.unstubAllGlobals();
  });

  it('media is the injected manager when given, else the client\'s own', () => {
    const own = new WebRTCClient({ websocketURL: 'wss://x', localVideo: null });
    expect(own.media).toBeInstanceOf(MediaManager);
    const injected = new MediaManager({});
    expect(new WebRTCClient({ websocketURL: 'wss://x', mediaManager: injected }).media).toBe(injected);
  });

  it('close() disposes a media manager it created, not an injected one', () => {
    const own = new WebRTCClient({ websocketURL: 'wss://x' });
    const ownDispose = vi.spyOn(own.media, 'dispose');
    own.close();
    expect(ownDispose).toHaveBeenCalledTimes(1);

    const injected = new MediaManager({});
    const injectedDispose = vi.spyOn(injected, 'dispose');
    new WebRTCClient({ websocketURL: 'wss://x', mediaManager: injected }).close();
    expect(injectedDispose).not.toHaveBeenCalled();
  });

  it('close() stops remote audio meters and closes the audio context', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const closeContext = vi.fn(async () => {});
    vi.stubGlobal('AudioContext', vi.fn(() => ({
      close: closeContext,
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => ({ fftSize: 0, frequencyBinCount: 4, getByteTimeDomainData: vi.fn(), disconnect: vi.fn() }),
    })));
    const client = new WebRTCClient({ websocketURL: 'wss://x' });
    // @ts-ignore private: the stream's remote media, as ontrack stores it
    client['remoteStreams'].set('s1', {} as MediaStream);
    const level = vi.fn();
    await client.enableRemoteAudioLevel('s1', level, 10);

    client.close();
    vi.advanceTimersByTime(50);

    expect(level).not.toHaveBeenCalled();
    expect(closeContext).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});


