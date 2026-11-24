import { Emitter } from "../core/emitter.js";
import { SDKError } from "../core/errors.js";
import type { EventMap } from "../core/events.js";
import type { PeerStats } from "../core/peer-stats.js";

import type { WebRTCClient } from "./webrtc-client.js";

/** The events about one stream: those whose payload names it. */
export type StreamEventMap = {
  [K in keyof EventMap as "streamId" extends keyof EventMap[K] ? K : never]: EventMap[K];
};

/**
 * `starting → live → (reconnecting ↔ live) → ended`; a start that fails or is stopped goes
 * `starting → ended`. `reconnecting` while the socket or the peer is being recovered.
 */
export type SessionState = "starting" | "live" | "reconnecting" | "ended";

/**
 * One stream of a {@link WebRTCClient}, returned as soon as it is started. It emits the events of
 * its own stream, the server's finished notification included (the source stopped, the session
 * stays); a stream that went live emits one finished event last, when it ends. It lives until
 * stop(), close() or a server stop; recovery keeps it. Until it is live, its stream methods fail
 * with `session_not_live`; once ended, with `session_ended`.
 */
export abstract class StreamSession extends Emitter<StreamEventMap> {
  /** @internal */
  protected readonly client: WebRTCClient;
  readonly streamId: string;
  private readonly started: Promise<void>;

  /** @internal */
  constructor(client: WebRTCClient, streamId: string, started: Promise<void>) {
    super();
    this.client = client;
    this.streamId = streamId;
    this.started = started;
    // a failed start is reported by ready(); unobserved it is no unhandled rejection
    started.catch(() => undefined);
  }

  /** Resolves with this session once the stream is live; rejects with the start's error. */
  ready(): Promise<this> {
    return this.started.then(() => this);
  }

  get state(): SessionState {
    return this.client.sessionState(this);
  }

  /** Null once ended: the stream id may belong to a new session by then. */
  get peerConnection(): RTCPeerConnection | null {
    return this.state === "ended" ? null : this.client.peerConnection(this.streamId);
  }

  /** End the stream, or cancel its start; resolves when done. Does nothing once ended. */
  async stop(): Promise<void> {
    if (this.state !== "ended") await this.client.stop(this.streamId);
  }

  async sendData(data: string | ArrayBuffer): Promise<void> {
    return this.live().sendData(this.streamId, data);
  }

  async getStats(): Promise<PeerStats | null> {
    return this.live().getStats(this.streamId);
  }

  enableStats(periodMs = 5000): void {
    this.live().enableStats(this.streamId, periodMs);
  }

  disableStats(): void {
    this.live().disableStats(this.streamId);
  }

  /** The client, while this session is live or reconnecting. */
  protected live(): WebRTCClient {
    const state = this.state;
    if (state === "ended") throw new SDKError("session_ended", `${this.streamId} has ended`);
    if (state === "starting") {
      throw new SDKError("session_not_live", `${this.streamId} is not live yet`);
    }
    return this.client;
  }
}

/** A stream this client publishes; returned by {@link WebRTCClient.publish}. */
export class PublishSession extends StreamSession {
  /** Sender max bitrate in kbps; `"unlimited"` removes the cap. */
  async changeBandwidth(bandwidth: number | "unlimited"): Promise<void> {
    return this.live().changeBandwidth(this.streamId, bandwidth);
  }

  async setDegradationPreference(preference: RTCDegradationPreference): Promise<void> {
    return this.live().setDegradationPreference(this.streamId, preference);
  }

  updateStreamMetaData(metaData: unknown): void {
    this.live().updateStreamMetaData(this.streamId, metaData);
  }
}

/** A stream this client plays; returned by {@link WebRTCClient.play}. */
export class PlaySession extends StreamSession {
  /** The remote media, once the first track arrived; null once ended. */
  get stream(): MediaStream | null {
    return this.state === "ended" ? null : this.client.remoteStream(this.streamId);
  }

  /** Force an ABR height; 0 returns to automatic. */
  async forceStreamQuality(height: number): Promise<void> {
    return this.live().forceStreamQuality(this.streamId, height);
  }

  /** Enable or disable a subtrack of the played room. */
  async enableTrack(trackId: string, enabled: boolean): Promise<void> {
    return this.live().enableTrack(this.streamId, trackId, enabled);
  }

  toggleVideo(trackId: string, enabled: boolean): void {
    this.live().toggleVideo(this.streamId, trackId, enabled);
  }

  toggleAudio(trackId: string, enabled: boolean): void {
    this.live().toggleAudio(this.streamId, trackId, enabled);
  }

  async enableRemoteAudioLevel(callback: (level: number) => void, periodMs = 200): Promise<void> {
    return this.live().enableRemoteAudioLevel(this.streamId, callback, periodMs);
  }

  disableRemoteAudioLevel(): void {
    this.live().disableRemoteAudioLevel(this.streamId);
  }

  /** Put participant `streamId` on video track `videoTrackId` (pin), or release it. */
  async assignVideoTrack(videoTrackId: string, streamId: string, enabled: boolean): Promise<void> {
    return this.live().assignVideoTrack(streamId, videoTrackId, enabled);
  }

  /** Pagination window of the video track assignments. */
  async updateVideoTrackAssignments(offset: number, size: number): Promise<void> {
    return this.live().updateVideoTrackAssignments(this.streamId, offset, size);
  }

  async setMaxVideoTrackCount(maxTrackCount: number): Promise<void> {
    return this.live().setMaxVideoTrackCount(this.streamId, maxTrackCount);
  }

  /** The answer arrives as `video_track_assignments`. */
  async requestVideoTrackAssignments(): Promise<void> {
    return this.live().requestVideoTrackAssignments(this.streamId);
  }
}
