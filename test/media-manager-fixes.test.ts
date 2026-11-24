import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaManager } from '../src/core/media-manager.js';

class MockTrack {
  kind: 'audio' | 'video';
  enabled = true;
  onended: (() => void) | null = null;
  stop = vi.fn();
  constructor(kind: 'audio' | 'video') { this.kind = kind; }
}
class MockStream {
  private tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  addTrack(t: MediaStreamTrack) { this.tracks.push(t); }
  removeTrack(t: MediaStreamTrack) { this.tracks = this.tracks.filter(x => x !== t); }
}

let created: MockTrack[];
const track = (kind: 'audio' | 'video') => {
  const t = new MockTrack(kind);
  created.push(t);
  return t as unknown as MediaStreamTrack;
};

let getUserMedia: ReturnType<typeof vi.fn>;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let addEventListener: ReturnType<typeof vi.fn>;
let removeEventListener: ReturnType<typeof vi.fn>;
let acquired: MockStream[];
let gains: Array<{ gain: { value: number } }>;
let createMediaStreamSource: ReturnType<typeof vi.fn>;
let closeContext: ReturnType<typeof vi.fn>;
let sources: Array<{ disconnect: ReturnType<typeof vi.fn> }>;
let analysers: Array<{ disconnect: ReturnType<typeof vi.fn> }>;
let displayAudio: boolean;

// longer than the delayed stop of a replaced audio track
const settle = () => new Promise(r => setTimeout(r, 60));

describe('media-manager fixes', () => {
  beforeEach(() => {
    created = [];
    acquired = [];
    gains = [];
    displayAudio = false;
    getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      // resolve on a macrotask: fire-and-forget callers must not appear to succeed
      await new Promise(r => setTimeout(r, 0));
      const s = new MockStream([
        ...(c.video ? [track('video')] : []),
        ...(c.audio ? [track('audio')] : []),
      ]);
      acquired.push(s);
      return s as unknown as MediaStream;
    });
    getDisplayMedia = vi.fn(async (c: MediaStreamConstraints) =>
      new MockStream([track('video'), ...(displayAudio && c.audio ? [track('audio')] : [])]) as unknown as MediaStream);
    enumerateDevices = vi.fn(async () => []);
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia, getDisplayMedia, enumerateDevices, addEventListener, removeEventListener },
    });
    vi.stubGlobal('MediaStream', MockStream);
    sources = [];
    analysers = [];
    createMediaStreamSource = vi.fn(() => {
      const source = { connect: (n: unknown) => n, disconnect: vi.fn() };
      sources.push(source);
      return source;
    });
    closeContext = vi.fn(async () => {});
    vi.stubGlobal('AudioContext', vi.fn(() => ({
      close: closeContext,
      createMediaStreamSource,
      createGain: vi.fn(() => {
        const g = { gain: { value: 1 }, connect: (n: unknown) => n };
        gains.push(g);
        return g;
      }),
      createMediaStreamDestination: vi.fn(() => ({ stream: new MockStream([track('audio')]) })),
      createAnalyser: vi.fn(() => {
        const analyser = {
          fftSize: 256,
          frequencyBinCount: 128,
          getByteTimeDomainData: (d: Uint8Array) => d.fill(128),
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        analysers.push(analyser);
        return analyser;
      }),
    })));
    vi.stubGlobal('document', {
      createElement: (tag: string) =>
        tag === 'canvas'
          ? {
              width: 0,
              height: 0,
              getContext: () => ({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }),
              captureStream: () => new MockStream([track('video')]),
            }
          : { srcObject: null, muted: false, videoWidth: 0, videoHeight: 0, play: async () => {} },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('applies the volume level on the first setVolumeLevel call', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.setVolumeLevel(0.3);
    expect(gains).toHaveLength(1);
    expect(gains[0].gain.value).toBe(0.3);
  });

  it('acquires the gain source mic with the selected audio input', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.selectAudioInput('mic-2');
    getUserMedia.mockClear();
    await mm.setVolumeLevel(0.5);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'mic-2' } },
      video: false,
    });
  });

  it('meters the probe stream, not the muted local stream', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    mm.muteLocalMic();
    await mm.enableAudioLevelWhenMuted(() => {});
    const probe = acquired[acquired.length - 1];
    expect(createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(createMediaStreamSource).toHaveBeenCalledWith(probe);
    expect(createMediaStreamSource).not.toHaveBeenCalledWith(mm.getLocalStream());
    mm.disableAudioLevelWhenMuted();
  });

  it('stopScreenShare swaps video only and leaves audio alone', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.startScreenShare();
    const audio = mm.getLocalStream()!.getAudioTracks()[0];
    getUserMedia.mockClear();

    await mm.stopScreenShare();

    expect(audio.stop).not.toHaveBeenCalled();
    expect(mm.getLocalStream()!.getAudioTracks()[0]).toBe(audio);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
  });

  it('stopScreenShare after a mixed share brings back a plain mic and releases the mix', async () => {
    displayAudio = true;
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.startScreenShare();
    const mixMic = acquired[acquired.length - 1].getAudioTracks()[0];
    const mixed = mm.getLocalStream()!.getAudioTracks()[0];
    getUserMedia.mockClear();

    await mm.stopScreenShare();
    await settle();

    expect(mixMic.stop).toHaveBeenCalled();
    expect(mixed.stop).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    const mic = acquired.filter(s => s.getAudioTracks().length > 0).pop()!.getAudioTracks()[0];
    expect(mm.getLocalStream()!.getAudioTracks()).toEqual([mic]);
    expect((mm as any).primaryGainNode).toBeNull();
    expect((mm as any).secondaryGainNode).toBeNull();
    expect((mm as any).mixMicStream).toBeNull();
  });

  it('stopScreenShare after a mixed share keeps the user volume on the restored mic', async () => {
    displayAudio = true;
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.setVolumeLevel(0.3);
    await mm.startScreenShare();
    const mixMic = acquired[acquired.length - 1].getAudioTracks()[0];
    const gainsBefore = gains.length;

    await mm.stopScreenShare();
    await settle();

    expect(mixMic.stop).toHaveBeenCalled();
    expect(gains).toHaveLength(gainsBefore + 1);
    const gain = gains[gains.length - 1];
    expect(gain.gain.value).toBe(0.3);
    expect((mm as any).primaryGainNode).toBe(gain);
    expect((mm as any).secondaryGainNode).toBeNull();
    // outgoing audio is the processed track, not a raw capture
    // acquired[0] is the local stream itself
    const raw = acquired.slice(1).flatMap(s => s.getAudioTracks());
    expect(raw).not.toContain(mm.getLocalStream()!.getAudioTracks()[0]);
  });

  it('stopScreenShare after a mixed share releases the gain mic when the volume went back to 1', async () => {
    displayAudio = true;
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.setVolumeLevel(0.3);
    const gainMic = acquired[acquired.length - 1].getAudioTracks()[0];
    await mm.setVolumeLevel(1);
    await mm.startScreenShare();
    const gainsBefore = gains.length;

    await mm.stopScreenShare();
    await settle();

    expect(gainMic.stop).toHaveBeenCalled();
    expect(gains).toHaveLength(gainsBefore + 1);
    expect(gains[gains.length - 1].gain.value).toBe(1);
    expect((mm as any).primaryGainNode).toBe(gains[gains.length - 1]);
  });

  it('stopScreenWithCameraOverlay swaps video only and leaves audio alone', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    const audio = mm.getLocalStream()!.getAudioTracks()[0];
    await mm.startScreenWithCameraOverlay();
    getUserMedia.mockClear();

    await mm.stopScreenWithCameraOverlay();

    expect(audio.stop).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
  });

  it('honors the selected camera when restoring after screen share', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.selectVideoInput('cam-2');
    await mm.startScreenShare();
    getUserMedia.mockClear();
    await mm.stopScreenShare();
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { deviceId: { exact: 'cam-2' } },
      audio: false,
    });
  });

  it('keeps a muted mic muted across selectAudioInput', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    mm.muteLocalMic();
    await mm.selectAudioInput('mic-2');
    const mic = acquired[acquired.length - 1].getAudioTracks()[0];
    expect(mic.enabled).toBe(false);
    await settle();
    expect(mm.getLocalStream()!.getAudioTracks()).toHaveLength(1);
    expect(mm.getLocalStream()!.getAudioTracks()[0]).toBe(mic);
    mm.unmuteLocalMic();
    expect(mic.enabled).toBe(true);
  });

  it('keeps a muted mic muted when screen share mixes system audio', async () => {
    displayAudio = true;
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    mm.muteLocalMic();
    await mm.startScreenShare();
    await settle();
    const audio = mm.getLocalStream()!.getAudioTracks();
    expect(audio).toHaveLength(1);
    expect(audio[0].enabled).toBe(false);
  });

  it('applies a stored mute and pause to a re-initialized stream', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    mm.muteLocalMic();
    mm.pauseLocalTrack('video');
    await mm.initLocalStream();
    const s = mm.getLocalStream()!;
    expect(s.getAudioTracks()[0].enabled).toBe(false);
    expect(s.getVideoTracks()[0].enabled).toBe(false);
  });

  it('devicechange only refreshes the device list', async () => {
    enumerateDevices.mockResolvedValue([
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Cam' },
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Mic' },
    ]);
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    const before = [...mm.getLocalStream()!.getTracks()];
    const onDevices = vi.fn();
    mm.on('devices_updated', onDevices);
    getUserMedia.mockClear();
    const onChange = addEventListener.mock.calls.find(c => c[0] === 'devicechange')![1];

    onChange();
    await settle();

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(mm.getLocalStream()!.getTracks()).toEqual(before);
    expect(onDevices).toHaveBeenCalledTimes(1);
  });

  it('stores the camera selection while the camera is off', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    mm.turnOffLocalCamera();
    getUserMedia.mockClear();

    await mm.selectVideoInput('cam-2');
    expect(getUserMedia).not.toHaveBeenCalled();

    await mm.turnOnLocalCamera();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { exact: 'cam-2' } }, audio: false });
  });

  it('stores the camera selection while a screen share is active', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.startScreenShare();
    const screen = mm.getLocalStream()!.getVideoTracks()[0];
    getUserMedia.mockClear();

    await mm.selectVideoInput('cam-2');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(mm.getLocalStream()!.getVideoTracks()).toHaveLength(1);
    expect(mm.getLocalStream()!.getVideoTracks()[0]).toBe(screen);
  });

  it('restores the camera on the senders when the browser ends the screen share', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.startScreenShare();
    const screen = mm.getLocalStream()!.getVideoTracks()[0] as unknown as MockTrack;
    const changed = vi.fn();
    mm.on('local_tracks_changed', changed);

    screen.onended!();
    await settle();

    const cam = acquired[acquired.length - 1].getVideoTracks()[0];
    expect(mm.getLocalStream()!.getVideoTracks()).toHaveLength(1);
    expect(mm.getLocalStream()!.getVideoTracks()[0]).toBe(cam);
    expect(changed).toHaveBeenCalled();
  });

  it('startScreenShare without system audio leaves the audio track alone', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    const audio = mm.getLocalStream()!.getAudioTracks()[0];
    await mm.startScreenShare();
    await settle();
    expect(mm.getLocalStream()!.getAudioTracks()).toHaveLength(1);
    expect(mm.getLocalStream()!.getAudioTracks()[0]).toBe(audio);
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it('rebuilds the gain chain on the new mic with the stored level', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.setVolumeLevel(0.3);
    await mm.selectAudioInput('mic-2');
    await settle();

    const mic = acquired[acquired.length - 1];
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-2' } }, video: false });
    expect(gains).toHaveLength(2);
    expect(gains[1].gain.value).toBe(0.3);
    expect(createMediaStreamSource).toHaveBeenLastCalledWith(mic);
    expect(mm.getLocalStream()!.getAudioTracks()).not.toContain(mic.getAudioTracks()[0]);
  });

  it('keeps the volume chain on the old mic when the new mic cannot be opened', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    await mm.setVolumeLevel(0.3);
    const oldMic = acquired[acquired.length - 1].getAudioTracks()[0] as unknown as MockTrack;
    const sent = mm.getLocalStream()!.getAudioTracks()[0];
    getUserMedia.mockRejectedValueOnce(new Error('busy'));

    await expect(mm.selectAudioInput('mic-2')).rejects.toThrow('busy');
    await settle();
    expect(oldMic.stop).not.toHaveBeenCalled();
    expect(mm.getLocalStream()!.getAudioTracks()).toEqual([sent]);
  });

  it('runs the muted probe and the local meter independently', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    const local = vi.fn();
    const probe = vi.fn();
    await mm.enableAudioLevelForLocalStream(local, 200);
    await mm.enableAudioLevelWhenMuted(probe);
    vi.advanceTimersByTime(200);
    expect(local).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);

    mm.disableAudioLevelWhenMuted();
    vi.advanceTimersByTime(200);
    expect(local).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(1);

    await mm.enableAudioLevelWhenMuted(probe);
    mm.disableAudioLevelForLocalStream();
    vi.advanceTimersByTime(200);
    expect(local).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('dispose releases every track, timer and listener and can run twice', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    displayAudio = true;
    const localVideo = { srcObject: null } as unknown as HTMLVideoElement;
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true }, localVideo });
    await mm.initLocalStream();
    mm.turnOffLocalCamera(); // black track, frame timer
    await mm.setVolumeLevel(0.5); // gain input mic
    await mm.startScreenShare(); // screen video, system audio, mix mic
    await mm.startScreenWithCameraOverlay(); // overlay timer, overlay camera
    await mm.enableAudioLevelForLocalStream(() => {});
    await mm.enableAudioLevelWhenMuted(() => {}); // probe mic
    expect(vi.getTimerCount()).toBe(4);

    mm.dispose();
    await settle();

    expect(created.filter(t => t.stop.mock.calls.length === 0)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(closeContext).toHaveBeenCalledTimes(1);
    const onChange = addEventListener.mock.calls.find(c => c[0] === 'devicechange')![1];
    expect(removeEventListener).toHaveBeenCalledWith('devicechange', onChange);
    expect(localVideo.srcObject).toBeNull();

    expect(() => mm.dispose()).not.toThrow();
    expect(closeContext).toHaveBeenCalledTimes(1);
  });

  it('a device call before any stream leaves the full stream initLocalStream() opens', async () => {
    const calls: Array<[string, (mm: MediaManager) => Promise<void>]> = [
      ['selectVideoInput', mm => mm.selectVideoInput('cam-2')],
      ['selectAudioInput', mm => mm.selectAudioInput('mic-2')],
      ['turnOnLocalCamera', mm => mm.turnOnLocalCamera()],
      ['startScreenShare', mm => mm.startScreenShare()],
      ['startScreenWithCameraOverlay', mm => mm.startScreenWithCameraOverlay()],
      ['setVolumeLevel', mm => mm.setVolumeLevel(0.5)],
    ];
    for (const [name, call] of calls) {
      const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
      await call(mm);
      const s = mm.getLocalStream();
      expect([s?.getVideoTracks().length, s?.getAudioTracks().length], name).toEqual([1, 1]);
      mm.dispose();
    }
  });

  it('a device selection before any stream opens the stream on that device, once', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.selectVideoInput('cam-2');
    await mm.selectAudioInput('mic-2');
    expect(getUserMedia.mock.calls).toEqual([
      [{ video: { deviceId: { exact: 'cam-2' } }, audio: true }],
      [{ audio: { deviceId: { exact: 'mic-2' } }, video: false }],
    ]);
  });

  it('turnOffLocalCamera before any stream only records that the camera is off', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    mm.turnOffLocalCamera();
    expect(mm.getLocalStream()).toBeNull();
    await mm.initLocalStream();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
  });

  for (const [start, stop] of [
    ['startScreenShare', 'stopScreenShare'],
    ['startScreenWithCameraOverlay', 'stopScreenWithCameraOverlay'],
  ] as const) {
    it(`camera off and on during ${start} only record the camera state`, async () => {
      const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
      await mm.initLocalStream();
      await mm[start]();
      const shared = mm.getLocalStream()!.getVideoTracks()[0];
      getUserMedia.mockClear();

      mm.turnOffLocalCamera();
      expect(mm.getLocalStream()!.getVideoTracks()).toEqual([shared]);
      await mm.turnOnLocalCamera();
      expect(mm.getLocalStream()!.getVideoTracks()).toEqual([shared]);
      expect(getUserMedia).not.toHaveBeenCalled();

      // the recorded state applies when the share ends: black frames, no camera
      mm.turnOffLocalCamera();
      await mm[stop]();
      expect(getUserMedia).not.toHaveBeenCalled();
      const video = mm.getLocalStream()!.getVideoTracks();
      expect(video).toHaveLength(1);
      expect(video[0]).not.toBe(shared);
      mm.dispose();
    });

    it(`emits screen_share_stopped when the browser ends ${start}`, async () => {
      const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
      await mm.initLocalStream();
      await mm[start]();
      const stopped = vi.fn();
      mm.on('screen_share_stopped', stopped);
      (mm as any).screenVideoTrack.onended();
      await settle();
      expect(stopped).toHaveBeenCalledTimes(1);
      mm.dispose();
    });
  }

  it('stopping a share when none is active does nothing', async () => {
    for (const stop of ['stopScreenShare', 'stopScreenWithCameraOverlay'] as const) {
      const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
      await mm[stop]();
      expect(mm.getLocalStream(), stop).toBeNull();

      await mm.initLocalStream();
      const tracks = [...mm.getLocalStream()!.getTracks()];
      getUserMedia.mockClear();
      await mm[stop]();
      expect(getUserMedia, stop).not.toHaveBeenCalled();
      expect(mm.getLocalStream()!.getTracks(), stop).toEqual(tracks);
      mm.dispose();
    }
  });

  for (const start of ['startScreenShare', 'startScreenWithCameraOverlay'] as const) {
    it(`${start} stops the captured screen when the camera or microphone fails after it`, async () => {
      displayAudio = true;
      // without a stream the local stream fails to open; with one, the mix mic or overlay camera
      for (const withStream of [false, true]) {
        const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
        if (withStream) await mm.initLocalStream();
        const before = created.length;
        getUserMedia.mockRejectedValueOnce(new Error('denied'));

        await expect(mm[start](), `${withStream}`).rejects.toThrow('denied');
        const screen = created.slice(before);
        expect(screen.length, `${withStream}`).toBeGreaterThan(0);
        expect(screen.filter(t => t.stop.mock.calls.length === 0), `${withStream}`).toEqual([]);
        // no share is left recorded as active
        expect((mm as any).screenVideoTrack, `${withStream}`).toBeNull();
        mm.dispose();
      }
    });
  }

  it('reports the mic, camera and share state it tracks', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    expect([mm.micMuted, mm.cameraOff, mm.screenSharing]).toEqual([false, false, false]);

    // recorded before any stream exists
    mm.muteLocalMic();
    mm.turnOffLocalCamera();
    expect([mm.micMuted, mm.cameraOff]).toEqual([true, true]);
    await mm.initLocalStream();
    mm.unmuteLocalMic();
    await mm.turnOnLocalCamera();
    expect([mm.micMuted, mm.cameraOff]).toEqual([false, false]);

    for (const [start, stop] of [
      ['startScreenShare', 'stopScreenShare'],
      ['startScreenWithCameraOverlay', 'stopScreenWithCameraOverlay'],
    ] as const) {
      await mm[start]();
      expect(mm.screenSharing, start).toBe(true);
      await mm[stop]();
      expect(mm.screenSharing, stop).toBe(false);
    }

    // ended from the browser's own control: false by the time the event fires
    await mm.startScreenShare();
    let atEvent: boolean | undefined;
    mm.on('screen_share_stopped', () => (atEvent = mm.screenSharing));
    (mm.getLocalStream()!.getVideoTracks()[0] as unknown as MockTrack).onended!();
    await settle();
    expect(atEvent).toBe(false);
    mm.dispose();
  });

  it('turnOnLocalCamera that cannot open the camera leaves it off, sending black, and rejects', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    mm.turnOffLocalCamera();
    getUserMedia.mockRejectedValueOnce(new Error('busy'));

    await expect(mm.turnOnLocalCamera()).rejects.toThrow('busy');
    expect(mm.cameraOff).toBe(true);
    const video = mm.getLocalStream()!.getVideoTracks() as unknown as MockTrack[];
    expect(video).toHaveLength(1);
    expect(video[0].stop).not.toHaveBeenCalled();
    mm.dispose();
  });

  it('a device selection that cannot be opened keeps the previous selection', async () => {
    for (const [select, kind, key] of [
      ['selectVideoInput', 'video', 'selectedVideoInputId'],
      ['selectAudioInput', 'audio', 'selectedAudioInputId'],
    ] as const) {
      const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
      await mm.initLocalStream();
      await mm[select]('dev-1');
      getUserMedia.mockRejectedValueOnce(new Error('busy'));

      await expect(mm[select]('dev-2'), select).rejects.toThrow('busy');
      expect((await mm.listDevices())[key], select).toBe('dev-1');
      getUserMedia.mockClear();
      await mm.initLocalStream();
      expect(getUserMedia.mock.calls[0][0][kind], select).toEqual({ deviceId: { exact: 'dev-1' } });
      mm.dispose();
    }
  });

  it('the local meter releases its audio nodes and follows a swapped audio track', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    const level = vi.fn();
    await mm.enableAudioLevelForLocalStream(level, 200);
    expect(sources).toHaveLength(1);

    await mm.selectAudioInput('mic-2');
    expect(sources).toHaveLength(2);
    expect(sources[0].disconnect).toHaveBeenCalled();
    expect(analysers[0].disconnect).toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(level).toHaveBeenCalledTimes(1);

    mm.disableAudioLevelForLocalStream();
    expect(sources[1].disconnect).toHaveBeenCalled();
    expect(analysers[1].disconnect).toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(level).toHaveBeenCalledTimes(1);
    mm.dispose();
  });

  it('mute and unmute are the audio pause and resume, events included', async () => {
    const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
    await mm.initLocalStream();
    const events: string[] = [];
    mm.on('local_track_paused', ({ kind }) => events.push(`paused:${kind}`));
    mm.on('local_track_resumed', ({ kind }) => events.push(`resumed:${kind}`));

    mm.muteLocalMic();
    expect(mm.getLocalStream()!.getAudioTracks()[0].enabled).toBe(false);
    mm.unmuteLocalMic();
    expect(events).toEqual(['paused:audio', 'resumed:audio']);
    mm.dispose();
  });

  it('constructs without a document (SSR)', () => {
    vi.stubGlobal('document', undefined);
    expect(() => {
      const mm = new MediaManager({ mediaConstraints: { audio: true, video: true } });
      mm.turnOffLocalCamera();
    }).not.toThrow();
  });
});
