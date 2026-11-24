import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocketAdaptor } from '../src/core/websocket-adaptor.js';

// Test ping without creating a real WebSocket

describe('websocket ping', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends periodic ping after startPing', async () => {
    vi.useFakeTimers();
    const sends: any[] = [];
    const wsa = new WebSocketAdaptor({ onEvent: () => {} } as any);
    // @ts-ignore private
    wsa['ws'] = { readyState: 1, send: (t: string) => sends.push(JSON.parse(t)) } as any;
    // @ts-ignore private
    wsa['connected'] = true;
    // @ts-ignore private
    wsa['startPing']();

    await vi.advanceTimersByTimeAsync(3100);
    // @ts-ignore private
    wsa['clearPing']();

    expect(sends.find((m) => m.command === 'ping')).toBeTruthy();

    // and it stops once cleared
    const countAfterClear = sends.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(sends.length).toBe(countAfterClear);
  });
});
