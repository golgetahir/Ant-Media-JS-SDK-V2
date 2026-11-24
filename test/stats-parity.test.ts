import { describe, it, expect } from 'vitest';
import { WebRTCClient } from '../src/client/webrtc-client.js';

if (typeof (global as any).MediaStream === 'undefined') {
  (global as any).MediaStream = class {} as any;
}

class MockPC {
  async getStats() {
    const base = Date.now();
    return new Map<string, any>([
      ['out1', { type: 'outbound-rtp', kind: 'video', bytesSent: 5000, packetsSent: 50, frameWidth: 1280, frameHeight: 720, framesEncoded: 100, timestamp: base }],
      ['in1', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 3000, packetsReceived: 30, timestamp: base }],
      ['rin1', { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 2, roundTripTime: 0.06, jitter: 0.003 }],
      ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 4000000, currentRoundTripTime: 0.08 }],
    ]);
  }
}
// @ts-ignore
(global as any).RTCPeerConnection = MockPC;

describe('stats parity', () => {
  it('collects extended fields similar to v1', async () => {
    const adaptor = new WebRTCClient({ websocketURL: 'wss://x' });
    // @ts-ignore
    adaptor['peers'].set('s1', { pc: new RTCPeerConnection() as any });
    const ps = await adaptor.getStats('s1');
    expect(ps).toBeTruthy();
    // @ts-ignore
    expect(ps.frameWidth).toBe(1280);
    // @ts-ignore
    expect(ps.videoPacketsSent).toBe(50);
    // @ts-ignore
    expect(ps.totalBytesSent).toBe(5000);
    // @ts-ignore
    expect(ps.availableOutgoingBitrateKbps).toBe(4000);
  });
});

/** Client whose peer for s1 returns the given reports, one per getStats() call, then fails. */
function withReports(...reports: any[][]) {
  const client = new WebRTCClient({ websocketURL: 'wss://x' });
  const getStats = async () => {
    const report = reports.shift();
    if (!report) throw new Error('peer closed');
    return new Map(report.map((r, i) => [String(i), r]));
  };
  // @ts-ignore protected
  client['peers'].set('s1', { pc: { getStats } as any });
  return client;
}

describe('getStats', () => {
  it('reads viewer frame fields from inbound-rtp', async () => {
    const client = withReports([
      { type: 'inbound-rtp', kind: 'video', bytesReceived: 10, packetsReceived: 5, frameWidth: 640, frameHeight: 360, framesDecoded: 90, framesDropped: 3, framesReceived: 95, timestamp: 1000 },
    ]);
    expect(await client.getStats('s1')).toMatchObject({
      frameWidth: 640,
      frameHeight: 360,
      framesDecoded: 90,
      framesDropped: 3,
      framesReceived: 95,
      videoPacketsReceived: 5,
    });
  });

  it('reads round trip and available bitrate from the nominated candidate pair only', async () => {
    const client = withReports([
      { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.04, availableOutgoingBitrate: 2000000 },
      { type: 'candidate-pair', state: 'succeeded', nominated: false, currentRoundTripTime: 0.3, availableOutgoingBitrate: 500000 },
    ]);
    expect(await client.getStats('s1')).toMatchObject({
      currentRoundTripTime: 0.04,
      availableOutgoingBitrateKbps: 2000,
    });
  });

  it('reads a viewer\'s packet loss and jitter from inbound-rtp', async () => {
    const client = withReports([
      { type: 'inbound-rtp', kind: 'video', packetsLost: 4, jitter: 0.02, timestamp: 1000 },
      { type: 'inbound-rtp', kind: 'audio', packetsLost: 1, jitter: 0.005, timestamp: 1000 },
    ]);
    expect(await client.getStats('s1')).toMatchObject({
      videoPacketsLost: 4,
      videoJitter: 0.02,
      audioPacketsLost: 1,
      audioJitter: 0.005,
    });
  });

  it('fills the four bitrate fields from consecutive samples, in kbit/s like v1', async () => {
    const sample = (t: number, sent: number, received: number) => [
      { type: 'outbound-rtp', kind: 'video', bytesSent: sent, timestamp: t },
      { type: 'inbound-rtp', kind: 'audio', bytesReceived: received, timestamp: t },
    ];
    const client = withReports(sample(1000, 1000, 2000), sample(2000, 126_000, 64_500), sample(3000, 376_000, 64_500));
    // one sample is only the baseline
    const first = await client.getStats('s1');
    expect([first?.currentOutgoingBitrate, first?.averageIncomingBitrate]).toEqual([undefined, undefined]);

    // 125000 B and 62500 B in 1000 ms
    expect(await client.getStats('s1')).toMatchObject({
      currentOutgoingBitrate: 1000,
      averageOutgoingBitrate: 1000,
      currentIncomingBitrate: 500,
      averageIncomingBitrate: 500,
    });
    // current is against the previous sample, average against the first
    expect(await client.getStats('s1')).toMatchObject({
      currentOutgoingBitrate: 2000,
      averageOutgoingBitrate: 1500,
      currentIncomingBitrate: 0,
      averageIncomingBitrate: 250,
    });
  });

  it('returns null when getStats fails or there is no peer', async () => {
    const client = withReports();
    expect(await client.getStats('s1')).toBeNull();
    expect(await client.getStats('none')).toBeNull();
  });
});
