import { Logger, type LogLevel } from "../utils/logger.js";

/** A connection attempt not open by then is abandoned like a failed one. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Configuration options for {@link WebSocketAdaptor}.
 */
export interface WebSocketAdaptorOptions {
  websocketURL: string;
  /** Called with `initialized`, `closed`, `error` and the command of every server frame. */
  onEvent: (info: string, obj?: unknown) => void;
  debug?: boolean | LogLevel;
}

/**
 * Thin wrapper around WebSocket that adapts Ant Media's signaling protocol.
 */
export class WebSocketAdaptor {
  private ws?: WebSocket;
  private opts: WebSocketAdaptorOptions;
  private log: Logger;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Create a new WebSocket adaptor.
   */
  constructor(opts: WebSocketAdaptorOptions) {
    this.opts = opts;
    this.log = new Logger(
      typeof opts.debug === "string" ? opts.debug : opts.debug ? "debug" : "info"
    );
    this.connect();
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      this.send(JSON.stringify({ command: "ping" }));
    }, 3000);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Open a socket unless one is already connecting or open. */
  connect(): void {
    if (this.isConnected() || this.isConnecting()) return;
    this.log.info("connecting to websocket %s", this.opts.websocketURL);
    const ws = new WebSocket(this.opts.websocketURL);
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      this.log.warn("websocket did not open in %d ms", CONNECT_TIMEOUT_MS);
      this.close();
      this.opts.onEvent("closed", undefined);
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(this.connectTimer);
      this.log.info("websocket connected");
      this.startPing();
      this.opts.onEvent("initialized");
    };

    ws.onmessage = ev => {
      this.log.debug("ws message: %s", ev.data);
      try {
        const obj = JSON.parse(ev.data);
        if (obj && obj.command) {
          this.opts.onEvent(obj.command, obj);
        }
      } catch (e) {
        this.log.warn("ws message parse failed", e);
      }
    };

    ws.onerror = e => {
      this.clearPing();
      this.log.error("websocket error", e);
      // reported like a server error frame; the close that follows starts the reconnect
      const frame = { definition: "WebSocketNotConnected" };
      this.opts.onEvent("error", frame);
    };

    ws.onclose = ev => {
      clearTimeout(this.connectTimer);
      this.clearPing();
      this.log.warn("websocket closed");
      this.opts.onEvent("closed", ev);
    };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isConnecting(): boolean {
    return this.ws?.readyState === WebSocket.CONNECTING;
  }

  send(text: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.log.warn("send while not connected");
      return false;
    }
    this.log.debug("send: %s", text);
    this.ws.send(text);
    return true;
  }

  /** User-initiated close: the socket is detached first, so no closed/error event follows. */
  close(): void {
    clearTimeout(this.connectTimer);
    this.clearPing();
    const ws = this.ws;
    if (!ws) return;
    this.ws = undefined;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    ws.close();
  }
}
