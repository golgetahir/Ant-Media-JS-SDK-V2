import { describe, it, expect } from 'vitest';
import { generateRandomString, getWebSocketURL } from '../src/utils/utility.js';
import * as sdk from '../src/index.js';
import { WebRTCClient } from '../src/client/webrtc-client.js';

describe('utility', () => {
  it('generates string of length', () => {
    const s = generateRandomString(8);
    expect(s).toHaveLength(8);
  });
  it('builds ws URL', () => {
    const loc = {
      protocol: 'https:',
      hostname: 'example.com',
      port: '5443',
      pathname: '/LiveApp/index.html',
    } as unknown as Location;
    const url = getWebSocketURL(loc);
    expect(url).toBe('wss://example.com:5443/LiveApp/websocket');
  });
});

describe('public entry point', () => {
  it('exposes WebRTCClient, not the transport, the emitter or the old client names', () => {
    expect(sdk.WebRTCClient).toBe(WebRTCClient);
    expect(Object.keys(sdk).sort()).toEqual(
      ['MediaManager', 'PeerStats', 'SDKError', 'WebRTCClient', 'generateRandomString', 'getWebSocketURL'],
    );
    for (const name of ['WebSocketAdaptor', 'Emitter', 'Logger', 'BaseClient', 'StreamingClient', 'ConferenceClient']) {
      expect(sdk, name).not.toHaveProperty(name);
    }
  });
});
