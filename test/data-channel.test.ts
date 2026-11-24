import { describe, it, expect, vi } from 'vitest';
import { WebRTCClient } from '../src/client/webrtc-client.js';
import { SDKError } from '../src/core/errors.js';

if (typeof (global as any).MediaStream === 'undefined') {
  (global as any).MediaStream = class {} as any;
}

class MockDC {
  readyState = 'open';
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  private listeners: Record<string, Function[]> = {};
  send(_d: any) {}
  addEventListener(type: string, fn: any) {
    this.listeners[type] ||= [];
    this.listeners[type].push(fn);
  }
  removeEventListener(type: string, fn: any) {
    this.listeners[type] = (this.listeners[type]||[]).filter(f => f!==fn);
  }
  emit(type: string) {
    (this.listeners[type]||[]).forEach(f => f());
  }
}

/** Wire format shared with v1: an 8-byte header [token, total], then chunks [token, bytes...]. */
const header = (token: number, total: number) => {
  const ab = new ArrayBuffer(8);
  const dv = new DataView(ab);
  dv.setInt32(0, token, true);
  dv.setInt32(4, total, true);
  return ab;
};
const chunk = (token: number, bytes: number[]) => {
  const u8 = new Uint8Array(4 + bytes.length);
  new DataView(u8.buffer).setInt32(0, token, true);
  u8.set(bytes, 4);
  return u8.buffer;
};

/** Client with a data channel for `streamId`, recording data_received. */
function withChannel(streamIds: string[] = ['s1']) {
  const client = new WebRTCClient({ websocketURL: 'wss://x' });
  const received: Array<{ streamId: string; data: any }> = [];
  client.on('data_received', (e) => received.push(e));
  const dcs = streamIds.map((id) => {
    const dc = new MockDC();
    // @ts-ignore protected
    client['peers'].set(id, { pc: {} });
    // @ts-ignore protected
    client['setupDataChannel'](id, dc as any);
    return dc;
  });
  return { client, received, dcs };
}

const raceShort = (p: Promise<unknown>) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 20))]);

describe('Data channel chunking and reassembly', () => {
  it('reassembles binary chunks into a single ArrayBuffer', () => {
    const { received, dcs: [dc] } = withChannel(['sbin']);

    // simulate incoming header and chunks
    const payload = new Uint8Array(50000);
    for (let i=0;i<payload.length;i++) payload[i] = i % 251;
    const token = 1234;
    dc.onmessage!({ data: header(token, payload.byteLength) } as any);

    let sentTotal = 0;
    const CHUNK = 16000;
    while (sentTotal < payload.byteLength) {
      const size = Math.min(CHUNK, payload.byteLength - sentTotal);
      dc.onmessage!({ data: chunk(token, Array.from(payload.subarray(sentTotal, sentTotal + size))) } as any);
      sentTotal += size;
    }

    expect(received.length).toBe(1);
    const ab = received[0].data as ArrayBuffer;
    expect(ab.byteLength).toBe(payload.byteLength);
    expect(new Uint8Array(ab)).toEqual(payload);
  });

  it('completes a transfer whose last chunk carries 4 bytes, 8 bytes on the wire like a header', () => {
    const { received, dcs: [dc] } = withChannel();
    const payload = Array.from({ length: 16004 }, (_, i) => i % 251);
    dc.onmessage!({ data: header(5, 16004) } as any);
    dc.onmessage!({ data: chunk(5, payload.slice(0, 16000)) } as any);
    dc.onmessage!({ data: chunk(5, payload.slice(16000)) } as any);
    expect(received).toHaveLength(1);
    expect(new Uint8Array(received[0].data)).toEqual(new Uint8Array(payload));
  });

  it('evicts reassembly state left by an interrupted transfer', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { received, dcs: [dc] } = withChannel();

    // stale transfer: header arrives, chunks never do
    dc.onmessage!({ data: header(1, 1000) } as any);
    vi.setSystemTime(Date.now() + 31_000);
    // a new header triggers the lazy sweep
    dc.onmessage!({ data: header(2, 10) } as any);
    // token 1 is unknown now: its chunk is a plain message, token 2 still collects
    dc.onmessage!({ data: chunk(1, [1, 2, 3]) } as any);
    dc.onmessage!({ data: chunk(2, [1, 2, 3]) } as any);
    expect(received.map((e) => e.data.byteLength)).toEqual([7]);
    vi.useRealTimers();
  });
});

describe('data channel receive hardening', () => {
  it('ignores a header with length 0, negative or above the cap, without throwing', () => {
    const { received, dcs: [dc] } = withChannel();
    for (const [token, total] of [[1, 0], [2, -5], [3, 2 ** 30]]) {
      expect(() => dc.onmessage!({ data: header(token, total) } as any)).not.toThrow();
      expect(() => dc.onmessage!({ data: chunk(token, [1, 2, 3]) } as any)).not.toThrow();
    }
    // no transfer was opened: each chunk is a plain binary message
    expect(received.map((e) => e.data.byteLength)).toEqual([7, 7, 7]);
  });

  it('drops a transfer that receives more bytes than its header declared', () => {
    const { received, dcs: [dc] } = withChannel();
    dc.onmessage!({ data: header(1, 4) } as any);
    expect(() => dc.onmessage!({ data: chunk(1, [1, 2, 3, 4, 5, 6]) } as any)).not.toThrow();
    expect(received).toEqual([]);
    // the transfer is gone: a later chunk with its token is a plain message
    dc.onmessage!({ data: chunk(1, [9]) } as any);
    expect(received.map((e) => e.data.byteLength)).toEqual([5]);
  });

  it('keeps reassembly state per stream', () => {
    const { received, dcs: [dc1, dc2] } = withChannel(['s1', 's2']);
    dc1.onmessage!({ data: header(7, 3) } as any);
    // same token on another stream: not part of s1's transfer
    dc2.onmessage!({ data: chunk(7, [1, 2, 3]) } as any);
    expect(received.map((e) => [e.streamId, e.data.byteLength])).toEqual([['s2', 7]]);

    dc1.onmessage!({ data: chunk(7, [4, 5, 6]) } as any);
    expect(received[1].streamId).toBe('s1');
    expect(new Uint8Array(received[1].data)).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('emits video_track_assignments and track_list_updated, and data_received still fires', () => {
    const { client, dcs: [dc] } = withChannel(['room1']);
    const seen: unknown[] = [];
    client.on('video_track_assignments', (p) => seen.push(['assignments', p]));
    client.on('track_list_updated', (p) => seen.push(['updated', p]));
    client.on('data_received', ({ data }) => seen.push(['data', data]));
    // frames as the server's WebRTCClient builds them
    const assignments = {
      eventType: 'VIDEO_TRACK_ASSIGNMENT_LIST',
      streamId: 'room1',
      payload: [{ videoLabel: 'videoTrack0', trackId: 'p1', reserved: false }],
    };
    const updated = { command: 'event', eventType: 'TRACK_LIST_UPDATED', streamId: 'room1' };

    for (const data of [JSON.stringify(assignments), JSON.stringify(updated), 'not json', 'null']) {
      expect(() => dc.onmessage!({ data } as any)).not.toThrow();
    }
    expect(seen).toEqual([
      ['data', JSON.stringify(assignments)],
      ['assignments', assignments],
      ['data', JSON.stringify(updated)],
      ['updated', updated],
      ['data', 'not json'],
      ['data', 'null'],
    ]);
  });
});

describe('sendData', () => {
  it('rejects with SDKError when there is no open channel', async () => {
    const { client, dcs: [dc] } = withChannel();
    const noPeer = await client.sendData('none', 'x').catch((e: unknown) => e);
    expect(noPeer).toBeInstanceOf(SDKError);
    expect(noPeer).toMatchObject({ code: 'data_channel_not_available' });

    dc.readyState = 'closed';
    const send = vi.spyOn(dc, 'send');
    expect(await client.sendData('s1', 'x').catch((e: unknown) => e)).toBeInstanceOf(SDKError);
    expect(await client.sendData('s1', new ArrayBuffer(10)).catch((e: unknown) => e)).toBeInstanceOf(SDKError);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects instead of hanging when the channel closes while its buffer drains', async () => {
    const { client, dcs: [dc] } = withChannel();
    // above the 1 MiB low-water mark: sendData waits for bufferedamountlow
    dc.bufferedAmount = 2 << 20;
    const sending = client.sendData('s1', new ArrayBuffer(40_000)).catch((e: unknown) => e);
    await Promise.resolve();
    dc.readyState = 'closed';
    dc.emit('close');
    expect(await raceShort(sending)).toBeInstanceOf(SDKError);
  });
});
