import { describe, it, expect, vi } from 'vitest';
import { Emitter } from '../src/core/emitter.js';

interface Map {
  a: { x: number };
  b: void;
  error: { error: string };
}

describe('Emitter', () => {
  it('emits and listens', () => {
    const e = new Emitter<Map>();
    const fn = vi.fn();
    e.on('a', fn);
    e.emit('a', { x: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ x: 1 });
  });

  it('once only fires once', () => {
    const e = new Emitter<Map>();
    const fn = vi.fn();
    e.once('a', fn);
    e.emit('a', { x: 1 });
    e.emit('a', { x: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('off removes handler', () => {
    const e = new Emitter<Map>();
    const fn = vi.fn();
    e.on('a', fn);
    e.off('a', fn);
    e.emit('a', { x: 3 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('on returns an unsubscribe function', () => {
    const e = new Emitter<Map>();
    const fn = vi.fn();
    const unsubscribe = e.on('a', fn);
    e.emit('a', { x: 1 });
    unsubscribe();
    e.emit('a', { x: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ x: 1 });
  });

  it('once returns an unsubscribe function that cancels before firing', () => {
    const e = new Emitter<Map>();
    const fn = vi.fn();
    const unsubscribe = e.once('a', fn);
    unsubscribe();
    e.emit('a', { x: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('registering the same handler twice is a no-op', () => {
    const e = new Emitter<Map>();
    const fn = vi.fn();
    e.on('a', fn);
    e.on('a', fn);
    e.emit('a', { x: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    // and a single off removes it
    e.off('a', fn);
    e.emit('a', { x: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler does not stop other handlers', () => {
    const e = new Emitter<Map>();
    const boom = vi.fn(() => { throw new Error('boom'); });
    const after = vi.fn();
    e.on('a', boom);
    e.on('a', after);
    expect(() => e.emit('a', { x: 1 })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('removeAllListeners clears one event or all of them', () => {
    const e = new Emitter<Map>();
    const a = vi.fn();
    const b = vi.fn();
    e.on('a', a);
    e.on('b', b);
    e.removeAllListeners('a');
    e.emit('a', { x: 1 });
    e.emit('b', undefined);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);

    e.on('a', a);
    e.removeAllListeners();
    e.emit('a', { x: 1 });
    e.emit('b', undefined);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
