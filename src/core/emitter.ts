import { Logger } from "../utils/logger.js";

import type { Unsubscribe } from "./events.js";

const log = new Logger("info");

/** Storage type: per-event map of original handler -> the function actually invoked. */
type StoredHandler = (payload: never) => void;

export class Emitter<EventMap extends object> {
  private handlers: Map<keyof EventMap, Map<StoredHandler, StoredHandler>> = new Map();

  /** Subscribe. Registering the same handler twice for one event is a no-op. */
  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): Unsubscribe {
    this.store(event, handler as unknown as StoredHandler, handler as unknown as StoredHandler);
    return () => this.off(event, handler);
  }

  off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
    this.handlers.get(event)?.delete(handler as unknown as StoredHandler);
  }

  /** Subscribe for a single emit. Deduped by the original handler, like {@link on}. */
  once<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): Unsubscribe {
    const wrapped = (payload: EventMap[K]) => {
      this.off(event, handler);
      handler(payload);
    };
    this.store(event, handler as unknown as StoredHandler, wrapped as unknown as StoredHandler);
    return () => this.off(event, handler);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const forEvent = this.handlers.get(event);
    if (!forEvent) return;
    for (const fn of Array.from(forEvent.values())) {
      try {
        (fn as (p: EventMap[K]) => void)(payload);
      } catch (e) {
        log.warn("event handler for %s threw", String(event), e);
      }
    }
  }

  /** Drop listeners for one event, or all events when called without arguments. */
  removeAllListeners(event?: keyof EventMap): void {
    if (event === undefined) this.handlers.clear();
    else this.handlers.delete(event);
  }

  private store(event: keyof EventMap, original: StoredHandler, invoked: StoredHandler): void {
    let forEvent = this.handlers.get(event);
    if (!forEvent) {
      forEvent = new Map();
      this.handlers.set(event, forEvent);
    }
    if (!forEvent.has(original)) forEvent.set(original, invoked);
  }
}
