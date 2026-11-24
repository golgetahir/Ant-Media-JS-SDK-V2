import type { GroupedDevices } from "./types.js";
import { Emitter } from "./emitter.js";
import type { EventMap } from "./events.js";

export interface MediaManagerOptions {
  mediaConstraints?: MediaStreamConstraints;
  localVideo?: HTMLVideoElement | null;
}

/**
 * Manages local media acquisition and device switching.
 */
export class MediaManager extends Emitter<EventMap> {
  private localStream: MediaStream | null = null;
  private localVideo: HTMLVideoElement | null;
  private constraints: MediaStreamConstraints;
  private screenVideoTrack: MediaStreamTrack | null = null;
  private screenShareAudioTrack: MediaStreamTrack | null = null;
  private cameraOverlayTrack: MediaStreamTrack | null = null;
  // the overlay's inset element, drawn from cameraOverlayTrack
  private overlayCamVideo: HTMLVideoElement | null = null;
  private overlayTimer: ReturnType<typeof setInterval> | null = null;
  private selectedVideoInputId: string | null = null;
  private selectedAudioInputId: string | null = null;
  private selectedAudioOutputId: string | null = null;
  // mute/pause survive track swaps; applied to every new track
  private paused = { audio: false, video: false };
  private cameraDisabled = false;
  // v1 parity: keep a dummy canvas based black frame stream when camera is off
  // created on first use so importing/constructing works without a DOM (SSR)
  private dummyCanvas: HTMLCanvasElement | null = null;
  private blackVideoTrack: MediaStreamTrack | null = null;
  private blackFrameTimer: ReturnType<typeof setInterval> | null = null;
  private replacementStream: MediaStream | null = null;

  /**
   * @param opts Media constraints and optional local preview element.
   */
  constructor(opts: MediaManagerOptions) {
    super();
    this.localVideo = opts.localVideo ?? null;
    this.constraints = opts.mediaConstraints ?? { video: true, audio: true };
  }

  /** True after muteLocalMic() or pauseLocalTrack("audio"), until undone. */
  get micMuted(): boolean {
    return this.paused.audio;
  }

  /** True after turnOffLocalCamera(), until turnOnLocalCamera(). */
  get cameraOff(): boolean {
    return this.cameraDisabled;
  }

  /** True during a screen share, with or without the camera overlay. */
  get screenSharing(): boolean {
    return this.screenVideoTrack !== null;
  }

  /** Return the currently active local stream, if any. */
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /** (Re)initialize local stream using current constraints and emit `devices_updated`. */
  async initLocalStream(): Promise<void> {
    // Stop and release any previously active tracks to avoid keeping devices (camera/mic) on
    if (this.localStream) {
      try {
        for (const track of this.localStream.getTracks()) {
          try {
            track.stop();
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }
    const requestConstraints: MediaStreamConstraints = this.cameraDisabled
      ? { ...this.constraints, video: false }
      : this.constraints;
    const stream = await navigator.mediaDevices.getUserMedia(requestConstraints);
    for (const t of stream.getTracks()) t.enabled = !this.paused[t.kind as "audio" | "video"];
    this.localStream = stream;
    if (this.localVideo) this.localVideo.srcObject = stream;
    this.remeterLocalAudio();
    await this.refreshDevices();

    try {
      // adding the same handler again is a no-op
      navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
    } catch {
      // ignore if unsupported
    }
  }

  /**
   * Open the local stream as initLocalStream() does when there is none, so a device call never
   * leaves a stream with only its own track; true if it opened one.
   */
  private async ensureLocalStream(): Promise<boolean> {
    if (this.localStream) return false;
    await this.initLocalStream();
    return true;
  }

  // v1 parity: a device change only refreshes the list, it never swaps tracks
  private readonly onDeviceChange = (): void => {
    this.refreshDevices().catch(() => {
      // ignore
    });
  };

  async refreshDevices(): Promise<GroupedDevices> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const grouped: GroupedDevices = {
      videoInputs: devices
        .filter(d => d.kind === "videoinput")
        .map(d => ({ deviceId: d.deviceId, label: d.label })),
      audioInputs: devices
        .filter(d => d.kind === "audioinput")
        .map(d => ({ deviceId: d.deviceId, label: d.label })),
      audioOutputs: devices
        .filter(d => d.kind === "audiooutput")
        .map(d => ({ deviceId: d.deviceId, label: d.label })),
      selectedVideoInputId: this.selectedVideoInputId || undefined,
      selectedAudioInputId: this.selectedAudioInputId || undefined,
    };
    // audio output selection (sinkId) is media element specific; we expose last selected if available
    grouped.selectedAudioOutputId = this.selectedAudioOutputId || undefined;
    this.emit("devices_updated", grouped);
    return grouped;
  }

  /** Enumerate and group available input/output devices. */
  async listDevices(): Promise<GroupedDevices> {
    return this.refreshDevices();
  }

  /** Pause local track of given kind (audio/video) without renegotiation. */
  pauseLocalTrack(kind: "audio" | "video"): void {
    if (this.setPaused(kind, true)) this.emit("local_track_paused", { kind });
  }

  /** Resume local track of given kind (audio/video). */
  resumeLocalTrack(kind: "audio" | "video"): void {
    if (this.setPaused(kind, false)) this.emit("local_track_resumed", { kind });
  }

  /** Store pause state for `kind` and apply it to current tracks; false if there is no stream. */
  private setPaused(kind: "audio" | "video", paused: boolean): boolean {
    this.paused[kind] = paused;
    if (!this.localStream) return false;
    for (const t of this.localStream.getTracks()) if (t.kind === kind) t.enabled = !paused;
    return true;
  }

  /** Update video constraints to use a specific deviceId or facingMode and refresh stream. */
  async selectVideoInput(source: string | { facingMode: "user" | "environment" }): Promise<void> {
    const video: MediaTrackConstraints =
      typeof source === "string"
        ? { deviceId: { exact: source } }
        : { facingMode: source.facingMode };
    const restore = this.saveSelection();
    this.constraints = { ...this.constraints, video };
    this.selectedVideoInputId = typeof source === "string" ? source : null;
    try {
      // no stream yet: it opens on the selection
      if (await this.ensureLocalStream()) return;
      // overlay share: its camera switches now, off or not (the draw loop leaves it out while off);
      // camera off or plain screen share: restoreCameraVideoTrack applies the selection later
      const inset = this.overlayCamVideo;
      if (inset) {
        const cam = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        const vtrack = cam.getVideoTracks()[0];
        if (vtrack && inset === this.overlayCamVideo) {
          inset.srcObject = new MediaStream([vtrack]);
          void inset.play().catch(() => {});
          this.cameraOverlayTrack?.stop();
          this.cameraOverlayTrack = vtrack;
        } else {
          // the share ended meanwhile: nothing would draw it
          vtrack?.stop();
        }
      } else if (!this.cameraDisabled && !this.screenVideoTrack) {
        const cam = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        const vtrack = cam.getVideoTracks()[0];
        if (vtrack) this.setLocalTrack(vtrack);
      }
    } catch (e) {
      restore();
      throw e;
    }
    await this.refreshDevices();
  }

  /** The constraints and input selections now; the returned function puts them back. */
  private saveSelection(): () => void {
    const { constraints, selectedVideoInputId, selectedAudioInputId } = this;
    return () => {
      this.constraints = constraints;
      this.selectedVideoInputId = selectedVideoInputId;
      this.selectedAudioInputId = selectedAudioInputId;
    };
  }

  /** Set audio output device (sinkId) for a given media element; stores selection for future emits. */
  async setAudioOutput(deviceId: string, element?: HTMLMediaElement | null): Promise<void> {
    const target: HTMLMediaElement | null = element ?? (this.localVideo as HTMLMediaElement | null);
    this.selectedAudioOutputId = deviceId || null;
    if (!target) return;
    const anyEl = target as unknown as { setSinkId?: (id: string) => Promise<void> };
    if (typeof anyEl.setSinkId === "function") {
      try {
        await anyEl.setSinkId(deviceId);
      } catch (e) {
        // surface via event channel
        this.emit("error", { error: "set_sink_id_failed", message: e });
      }
    } else {
      this.emit("error", { error: "set_sink_id_unsupported", message: target });
    }
    await this.refreshDevices();
  }

  /** Update audio constraints to use a specific deviceId and refresh stream. */
  async selectAudioInput(deviceId: string): Promise<void> {
    const audio: MediaTrackConstraints = { deviceId: { exact: deviceId } };
    const restore = this.saveSelection();
    this.constraints = { ...this.constraints, audio };
    this.selectedAudioInputId = deviceId;
    try {
      // no stream yet: it opens on the selection
      if (await this.ensureLocalStream()) return;
      if (this.primaryGainNode) {
        // keep volume control: rebuild the gain chain on the selected mic
        await this.installGainNodeForLocalAudio();
      } else {
        // Reacquire only audio and replace in-place (v1 parity)
        const onlyAudio = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        const atrack = onlyAudio.getAudioTracks()[0];
        if (atrack) this.setLocalTrack(atrack);
      }
    } catch (e) {
      restore();
      throw e;
    }
    await this.refreshDevices();
  }

  /**
   * Turn off the camera device: stop and remove local video track(s).
   * This turns off the camera light without renegotiation. Remote side will see video muted.
   */
  turnOffLocalCamera(): void {
    this.cameraDisabled = true;
    // no stream: it opens without the camera; a share: the overlay leaves the camera out and
    // restoreCameraVideoTrack applies it when the share ends
    if (!this.localStream || this.screenVideoTrack) return;
    // Initialize black dummy frame and keep sending at intervals similar to v1
    this.getBlackVideoTrack();
    const vtrack = this.replacementStream?.getVideoTracks()[0] || this.blackVideoTrack;
    if (vtrack) this.setLocalTrack(vtrack);
    if (this.localVideo && this.localVideo.srcObject !== this.localStream) {
      this.localVideo.srcObject = this.localStream as MediaStream;
    }
  }

  /**
   * Re-enable camera: if no local video track exists, reacquire one with current constraints and add it.
   * Does not renegotiate; callers should use replaceTrack on senders (handled by adaptor.applyLocalTracks).
   */
  async turnOnLocalCamera(): Promise<void> {
    this.cameraDisabled = false;
    this.clearBlackVideoTrackTimer();
    this.stopBlackVideoTrack();
    try {
      // a share keeps its video; restoreCameraVideoTrack brings the camera back when it ends
      if (this.screenVideoTrack || (await this.ensureLocalStream())) return;
      await this.restoreCameraVideoTrack();
    } catch (e) {
      // no camera: off again, with black frames as before
      this.turnOffLocalCamera();
      throw e;
    }
  }

  /** Selected camera constraint, falling back to the configured video constraint. */
  private videoConstraint(): MediaTrackConstraints | boolean {
    if (this.selectedVideoInputId) return { deviceId: { exact: this.selectedVideoInputId } };
    return this.constraints.video ?? true;
  }

  /** Selected mic constraint, falling back to the configured audio constraint. */
  private audioConstraint(): MediaTrackConstraints | boolean {
    if (this.selectedAudioInputId) return { deviceId: { exact: this.selectedAudioInputId } };
    return this.constraints.audio ?? true;
  }

  /** Re-acquire a camera video track and swap it in; audio is left untouched. */
  private async restoreCameraVideoTrack(): Promise<void> {
    if (this.cameraDisabled) {
      const black = this.getBlackVideoTrack();
      if (black) this.setLocalTrack(black);
      return;
    }
    const cam = await navigator.mediaDevices.getUserMedia({
      video: this.videoConstraint(),
      audio: false,
    });
    const vtrack = cam.getVideoTracks()[0];
    if (vtrack) this.setLocalTrack(vtrack);
  }

  // v1 parity helpers for black dummy track
  private getBlackVideoTrack(): MediaStreamTrack | null {
    if (typeof document === "undefined") return null;
    const canvas = (this.dummyCanvas ??= document.createElement("canvas"));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      if (canvas.width !== 320) {
        canvas.width = 320;
        canvas.height = 240;
      }
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // Always recapture to ensure a fresh live track
    this.replacementStream = canvas.captureStream(1);
    if (!this.blackFrameTimer) {
      this.blackFrameTimer = setInterval(() => {
        const c = canvas.getContext("2d");
        if (!c) return;
        c.fillStyle = "black";
        c.fillRect(0, 0, canvas.width, canvas.height);
      }, 3000);
    }
    this.blackVideoTrack = this.replacementStream.getVideoTracks()[0] ?? null;
    return this.blackVideoTrack;
  }

  private clearBlackVideoTrackTimer(): void {
    if (this.blackFrameTimer) {
      clearInterval(this.blackFrameTimer);
      this.blackFrameTimer = null;
    }
  }

  private stopBlackVideoTrack(): void {
    if (this.blackVideoTrack) {
      try {
        this.blackVideoTrack.stop();
      } catch {
        // ignore
      }
      this.blackVideoTrack = null;
    }
    this.replacementStream = null;
  }

  /** Disable sending from the current local audio track(s): pauseLocalTrack("audio"). */
  muteLocalMic(): void {
    this.pauseLocalTrack("audio");
  }

  /** Enable sending from the current local audio track(s): resumeLocalTrack("audio"). */
  unmuteLocalMic(): void {
    this.resumeLocalTrack("audio");
  }

  /** Replace local video track with a screen capture track. If system audio is available, mix with mic. */
  async startScreenShare(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const screen = (await (navigator.mediaDevices as any).getDisplayMedia({
      video: true,
      audio: true,
    })) as MediaStream;
    const vtrack = screen.getVideoTracks()[0];
    if (!vtrack) return;
    let mixed: MediaStream | null = null;
    try {
      // after getDisplayMedia, which needs the user's gesture
      await this.ensureLocalStream();
      // Mix system audio with mic if present; without it the mic track is left alone
      if (screen.getAudioTracks().length > 0) {
        for (const t of this.mixMicStream?.getTracks() ?? []) t.stop();
        this.mixMicStream = await navigator.mediaDevices.getUserMedia({
          audio: this.constraints.audio ?? true,
          video: false,
        });
        mixed = this.mixAudioStreams(screen, this.mixMicStream);
      }
    } catch (e) {
      // nothing would use the capture
      for (const t of screen.getTracks()) t.stop();
      throw e;
    }

    this.screenVideoTrack = vtrack;
    this.setLocalTrack(vtrack);
    const audioTrack = mixed?.getAudioTracks()[0];
    if (audioTrack) this.setLocalTrack(audioTrack);

    vtrack.onended = () => {
      void this.stopScreenShare();
      this.emit("screen_share_stopped", undefined);
    };
  }

  /** Restore camera video track by reinitializing getUserMedia with current constraints. */
  async stopScreenShare(): Promise<void> {
    // no share: nothing to restore
    if (!this.screenVideoTrack) return;
    try {
      this.screenVideoTrack.stop();
    } catch {
      // ignore
    }
    this.screenVideoTrack = null;
    // camera overlay share: stop its draw loop and inset camera
    if (this.overlayTimer) {
      clearInterval(this.overlayTimer);
      this.overlayTimer = null;
    }
    this.overlayCamVideo = null;
    if (this.cameraOverlayTrack) {
      try {
        this.cameraOverlayTrack.stop();
      } catch {
        // ignore
      }
      this.cameraOverlayTrack = null;
    }
    if (this.screenShareAudioTrack) {
      try {
        this.screenShareAudioTrack.stop();
      } catch {
        // ignore
      }
      this.screenShareAudioTrack = null;
    }
    // Swap video only: stopping/re-acquiring audio would cut the mic audibly
    await this.restoreCameraVideoTrack();
    // a system-audio mix is still the outgoing audio: release it and bring back a plain mic
    if (this.mixMicStream) {
      for (const t of this.mixMicStream.getTracks()) t.stop();
      this.mixMicStream = null;
      this.primaryGainNode = null;
      this.secondaryGainNode = null;
      if (this.gainInputStream) {
        await this.installGainNodeForLocalAudio();
      } else {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: this.audioConstraint(),
          video: false,
        });
        const atrack = mic.getAudioTracks()[0];
        if (atrack) this.setLocalTrack(atrack);
      }
    }
  }

  /** Start screen+camera overlay mode using canvas composition (v1 parity). */
  async startScreenWithCameraOverlay(): Promise<void> {
    // get screen video
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const screen = (await (navigator.mediaDevices as any).getDisplayMedia({
      video: true,
      audio: false,
    })) as MediaStream;
    const screenTrack = screen.getVideoTracks()[0];
    if (!screenTrack) return;
    let cam: MediaStream;
    try {
      // after getDisplayMedia, which needs the user's gesture
      await this.ensureLocalStream();
      // get camera video only
      cam = await navigator.mediaDevices.getUserMedia({
        video: this.constraints.video ?? true,
        audio: false,
      });
    } catch (e) {
      // nothing would use the capture
      for (const t of screen.getTracks()) t.stop();
      throw e;
    }
    const camTrack = cam.getVideoTracks()[0] ?? null;
    this.cameraOverlayTrack = camTrack;

    // prepare elements and canvas
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const screenVideo = document.createElement("video");
    const camVideo = (this.overlayCamVideo = document.createElement("video"));
    screenVideo.srcObject = new MediaStream([screenTrack]);
    camVideo.srcObject = camTrack ? new MediaStream([camTrack]) : null;
    screenVideo.muted = true;
    camVideo.muted = true;
    await Promise.all([screenVideo.play().catch(() => {}), camVideo.play().catch(() => {})]);

    const canvasStream = canvas.captureStream(15);

    // attach onended to auto-restore
    screenTrack.onended = () => {
      void this.stopScreenWithCameraOverlay();
      this.emit("screen_share_stopped", undefined);
    };

    // draw loop roughly 15fps
    const draw = () => {
      if (!ctx || screenVideo.videoWidth === 0 || screenVideo.videoHeight === 0) return;
      canvas.width = screenVideo.videoWidth;
      canvas.height = screenVideo.videoHeight;
      ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
      if (!this.cameraDisabled && camVideo.videoWidth > 0 && camVideo.videoHeight > 0) {
        const insetW = Math.floor(canvas.width * 0.15);
        const insetH = Math.floor((camVideo.videoHeight / camVideo.videoWidth) * insetW);
        const x = canvas.width - insetW - 15;
        const y = 15; // top-right
        ctx.drawImage(camVideo, x, y, insetW, insetH);
      }
    };
    this.overlayTimer = setInterval(draw, 66);

    // replace outgoing video with canvas stream
    const vtrack = canvasStream.getVideoTracks()[0];
    this.screenVideoTrack = screenTrack;
    if (vtrack) this.setLocalTrack(vtrack);
  }

  /** Stop screen+camera overlay and restore camera. */
  stopScreenWithCameraOverlay(): Promise<void> {
    return this.stopScreenShare();
  }

  // ===== Audio utilities (parity) =====
  private audioContext: AudioContext | null = null;
  private primaryGainNode: GainNode | null = null;
  private secondaryGainNode: GainNode | null = null;
  /** The local meter while on: its callback and period, and the function that stops it. */
  private localMeter: {
    callback: (level: number) => void;
    periodMs: number;
    stop: () => void;
  } | null = null;
  private mutedProbeStream: MediaStream | null = null;
  private stopMutedProbe: (() => void) | null = null;
  private lastVolume = 1;
  private gainInputStream: MediaStream | null = null;
  // source of the volume chain, released on rebuild
  private gainSourceNode: MediaStreamAudioSourceNode | null = null;
  // extra mic captured for mixing with screen-share system audio
  private mixMicStream: MediaStream | null = null;

  /** Set output volume (0..1) for local publishing stream. Installs the gain chain on first call. */
  async setVolumeLevel(level: number): Promise<void> {
    this.lastVolume = Math.max(0, Math.min(1, level));
    await this.ensureLocalStream();
    if (!this.primaryGainNode) {
      await this.installGainNodeForLocalAudio();
    }
    if (this.primaryGainNode) this.primaryGainNode.gain.value = this.lastVolume;
  }

  /** Ensure local audio runs through a GainNode for volume control and replace the track.
   *  Important: Use a dedicated mic capture stream as source to avoid feedback loops with localStream.
   */
  private async installGainNodeForLocalAudio(): Promise<void> {
    if (!this.localStream) return;
    const audioTracks = this.localStream.getAudioTracks();
    if (audioTracks.length === 0) return;
    // Acquire a fresh mic-only stream for processing, honoring the selected mic
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: this.audioConstraint(),
      video: false,
    });
    // release the previous mic only once the new one opened: a failure keeps the audio going
    for (const t of this.gainInputStream?.getTracks() ?? []) t.stop();
    this.gainSourceNode?.disconnect();
    this.primaryGainNode?.disconnect();
    this.gainInputStream = mic;
    if (!this.audioContext) this.audioContext = new AudioContext();
    const ctx = this.audioContext;
    this.gainSourceNode = ctx.createMediaStreamSource(mic);
    const destination = ctx.createMediaStreamDestination();
    this.primaryGainNode = ctx.createGain();
    this.primaryGainNode.gain.value = this.lastVolume;
    this.gainSourceNode.connect(this.primaryGainNode).connect(destination);
    const processedTrack = destination.stream.getAudioTracks()[0];
    if (processedTrack) this.setLocalTrack(processedTrack);
  }

  /** Mix system audio (screen) and mic into a single audio track. */
  private mixAudioStreams(screen: MediaStream, mic: MediaStream): MediaStream {
    const composed = new MediaStream();
    // Keep screen video in composed stream
    screen.getVideoTracks().forEach(t => composed.addTrack(t));
    if (!this.audioContext) this.audioContext = new AudioContext();
    const ctx = this.audioContext;
    const destination = ctx.createMediaStreamDestination();
    // system audio (primary)
    if (screen.getAudioTracks().length > 0) {
      const sys = new MediaStream([screen.getAudioTracks()[0]]);
      const s1 = ctx.createMediaStreamSource(sys);
      this.primaryGainNode = this.primaryGainNode || ctx.createGain();
      this.primaryGainNode.gain.value = this.lastVolume;
      s1.connect(this.primaryGainNode).connect(destination);
      this.screenShareAudioTrack = screen.getAudioTracks()[0];
    }
    // mic audio (secondary)
    if (mic.getAudioTracks().length > 0) {
      const m = new MediaStream([mic.getAudioTracks()[0]]);
      const s2 = ctx.createMediaStreamSource(m);
      this.secondaryGainNode = this.secondaryGainNode || ctx.createGain();
      this.secondaryGainNode.gain.value = 1;
      s2.connect(this.secondaryGainNode).connect(destination);
    }
    destination.stream.getAudioTracks().forEach(t => composed.addTrack(t));
    return composed;
  }

  /** Enable/disable secondary (mic) audio in mixed audio mode. */
  enableSecondStreamInMixedAudio(enable: boolean): void {
    if (this.secondaryGainNode) this.secondaryGainNode.gain.value = enable ? 1 : 0;
  }

  /** Enable simple audio level metering for the local stream; it follows the audio track. */
  async enableAudioLevelForLocalStream(
    callback: (level: number) => void,
    periodMs = 200
  ): Promise<void> {
    if (!this.localStream) return;
    this.disableAudioLevelForLocalStream();
    this.localMeter = {
      callback,
      periodMs,
      stop: this.meterStream(this.localStream, callback, periodMs),
    };
  }

  /** The local meter, when on, starts again on the current audio track. */
  private remeterLocalAudio(): void {
    if (!this.localMeter) return;
    const { callback, periodMs } = this.localMeter;
    void this.enableAudioLevelForLocalStream(callback, periodMs);
  }

  /**
   * Meter RMS level of `stream` and invoke `callback` every `periodMs`; returns the function that
   * stops it and disconnects its nodes.
   */
  private meterStream(
    stream: MediaStream,
    callback: (level: number) => void,
    periodMs: number
  ): () => void {
    if (!this.audioContext) this.audioContext = new AudioContext();
    const ctx = this.audioContext;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      // rough RMS
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      callback(rms);
    }, periodMs);
    return () => {
      clearInterval(timer);
      src.disconnect();
      analyser.disconnect();
    };
  }

  disableAudioLevelForLocalStream(): void {
    this.localMeter?.stop();
    this.localMeter = null;
  }

  /** Probe mic while muted to notify if speaking. */
  async enableAudioLevelWhenMuted(
    callback: (speaking: boolean) => void,
    threshold = 0.1
  ): Promise<void> {
    if (!this.audioContext) this.audioContext = new AudioContext();
    const probe = await navigator.mediaDevices.getUserMedia({
      audio: this.audioConstraint(),
      video: false,
    });
    this.disableAudioLevelWhenMuted();
    this.mutedProbeStream = probe;
    // Meter the probe: localStream tracks are disabled while muted, so they read silence
    this.stopMutedProbe = this.meterStream(
      probe,
      level => {
        callback(level > threshold);
      },
      200
    );
  }

  disableAudioLevelWhenMuted(): void {
    if (this.mutedProbeStream) {
      for (const t of this.mutedProbeStream.getTracks()) t.stop();
      this.mutedProbeStream = null;
    }
    this.stopMutedProbe?.();
    this.stopMutedProbe = null;
  }

  /** Release every track, timer, listener and audio context this manager holds. Idempotent. */
  dispose(): void {
    const released = !!this.localStream;
    this.disableAudioLevelForLocalStream();
    this.disableAudioLevelWhenMuted();
    this.clearBlackVideoTrackTimer();
    this.stopBlackVideoTrack();
    if (this.overlayTimer) {
      clearInterval(this.overlayTimer);
      this.overlayTimer = null;
    }
    const tracks = [
      ...(this.localStream?.getTracks() ?? []),
      ...(this.gainInputStream?.getTracks() ?? []),
      ...(this.mixMicStream?.getTracks() ?? []),
      this.screenVideoTrack,
      this.screenShareAudioTrack,
      this.cameraOverlayTrack,
    ];
    for (const t of tracks) {
      try {
        t?.stop();
      } catch {
        // ignore
      }
    }
    this.localStream = null;
    this.gainInputStream = null;
    this.mixMicStream = null;
    this.screenVideoTrack = null;
    this.screenShareAudioTrack = null;
    this.cameraOverlayTrack = null;
    this.overlayCamVideo = null;
    try {
      this.audioContext?.close().catch(() => {
        // ignore
      });
    } catch {
      // ignore
    }
    this.audioContext = null;
    this.gainSourceNode = null;
    this.primaryGainNode = null;
    this.secondaryGainNode = null;
    try {
      navigator.mediaDevices.removeEventListener("devicechange", this.onDeviceChange);
    } catch {
      // ignore without mediaDevices
    }
    if (this.localVideo) this.localVideo.srcObject = null;
    // controls showing the local tracks repaint from the released state
    if (released) this.emit("local_tracks_changed", undefined);
  }

  /** Single track-swap point: applies stored pause state, keeps one track per kind, notifies. */
  private setLocalTrack(track: MediaStreamTrack): void {
    const kind = track.kind as "audio" | "video";
    track.enabled = !this.paused[kind];
    const stream = (this.localStream ??= new MediaStream([]));
    const prev = stream.getTracks().filter(t => t.kind === kind && t !== track);
    for (const t of prev) stream.removeTrack(t);
    stream.addTrack(track);
    if (this.localVideo && this.localVideo.srcObject !== stream) this.localVideo.srcObject = stream;
    if (kind === "audio") this.remeterLocalAudio();
    this.emit("local_tracks_changed", undefined);
    const stop = () => {
      for (const t of prev) {
        try {
          t.stop();
        } catch {
          // ignore
        }
      }
    };
    // audio: stop shortly after so senders switch before the old mic goes silent
    if (kind === "audio") setTimeout(stop, 50);
    else stop();
  }
}
