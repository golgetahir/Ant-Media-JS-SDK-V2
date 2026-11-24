// Nothing in this suite may touch the network. Node 18+ ships a real global WebSocket, so any
// test constructing a client with a websocketURL would otherwise attempt a DNS lookup.
// Tests that need to drive the socket install their own mock with vi.stubGlobal.
class InertWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = InertWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {}
  send(): void {}
  close(): void {
    this.readyState = InertWebSocket.CLOSED;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

(globalThis as unknown as { WebSocket: unknown }).WebSocket = InertWebSocket;
