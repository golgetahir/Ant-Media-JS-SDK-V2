import { Logger } from "../utils/logger.js";
import { Emitter } from "../core/emitter.js";
import { SDKError, type ErrorCode } from "../core/errors.js";
import type {
  BroadcastObject,
  EventMap,
  IceServerConfigPayload,
  NotificationPayload,
  RoomInformation,
  RoomJoined,
  RoomLeft,
  StreamInformation,
  SubscriberCount,
  SubscriberList,
  SubtrackCount,
  SubtrackList,
  TakeCandidatePayload,
  TakeConfigurationPayload,
  TrackList,
  TrackListUpdated,
  Unsubscribe,
  VideoTrackAssignmentList,
} from "../core/events.js";
import { MediaManager } from "../core/media-manager.js";
import { PeerStats } from "../core/peer-stats.js";
import type {
  PlayOptions,
  PublishOptions,
  RoomJoinOptions,
  WebRTCClientOptions,
} from "../core/types.js";
import { WebSocketAdaptor } from "../core/websocket-adaptor.js";

import {
  PlaySession,
  PublishSession,
  type SessionState,
  type StreamEventMap,
  type StreamSession,
} from "./session.js";

interface PeerContext {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  videoSender?: RTCRtpSender;
  audioSender?: RTCRtpSender;
  mode?: StreamMode;
}

type StreamMode = "publish" | "play";

interface ActiveStreamInfo {
  mode: StreamMode;
  /** The publish/play command once sent, re-sent as is when the stream is recovered. */
  command?: Record<string, unknown>;
  /** Publish without local media. */
  dataOnly?: boolean;
  remoteVideo?: HTMLVideoElement | null;
  /** A session is ended when it is no longer the one here. */
  session?: StreamSession;
  /** Set by the server's started notification. */
  live?: boolean;
  /** Last changeBandwidth()/setDegradationPreference(), applied again to a recovered peer. */
  bandwidth?: number | "unlimited";
  degradation?: RTCDegradationPreference;
}

interface ChunkState {
  expected: number;
  received: number;
  buffers: Uint8Array[];
  /** Last activity, used to drop reassembly state of interrupted transfers. */
  ts: number;
}

const CHUNK_TTL_MS = 30_000;
/** Largest binary transfer accepted: a header's length is untrusted and sizes the buffer. */
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;

interface RemoteAudioMeter {
  analyser: AnalyserNode;
  timer: ReturnType<typeof setInterval>;
  data: Uint8Array;
  source: MediaStreamAudioSourceNode;
}

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;
const QUERY_TIMEOUT_MS = 10_000;
const STARTED = ["publish_started", "play_started"];

/** A sent command waiting for the server frame `key` about `id`. */
interface Waiter {
  key: string;
  id: string;
  resolve: (frame: unknown) => void;
  reject: (e: SDKError) => void;
}

/** `{command:"error"}` frame; stream errors carry streamId, room errors carry room. */
interface ErrorFrame {
  definition: string;
  streamId?: string;
  room?: string;
}

interface StatsSample {
  t: number;
  sent: number;
  recv: number;
}

/** getUserMedia failures v1 (media_manager.js) reports under their own name. */
const V1_MEDIA_ERRORS = [
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "OverconstrainedError",
];

/** The app's finished event of a stream. */
const FINISHED = { publish: "publish_finished", play: "play_finished" } as const;

interface ReconnectConfig {
  backoff: "fixed" | "exp";
  baseMs: number;
  maxMs: number;
  jitter: number;
}

/**
 * WebRTC client for Ant Media Server.
 *
 * One client holds one signaling socket and any number of streams: {@link publish} and
 * {@link play} start a stream and resolve with its session, which carries the calls about that
 * stream. Local devices are under {@link media}. The client emits the events of every stream
 * (see {@link EventMap}), recovers streams with backoff, and answers the server queries.
 */
export class WebRTCClient extends Emitter<EventMap> {
  private static pluginInitMethods: Array<(sdk: WebRTCClient) => void> = [];

  /** Register a plugin initializer, run once when a client's socket first opens. */
  static register(init: (sdk: WebRTCClient) => void): void {
    WebRTCClient.pluginInitMethods.push(init);
  }

  /** Local camera, microphone and screen share; publish sessions follow its tracks. */
  readonly media: MediaManager;
  private ws?: WebSocketAdaptor;
  /** False when the caller injected `mediaManager`; only an own manager is disposed on close(). */
  private readonly ownsMedia: boolean;
  private mediaUnsubs: Unsubscribe[];
  private log: Logger;
  private isReady = false;
  private sanitizeDcStrings: boolean;
  private autoReconnect: boolean;
  private reconnectConfig: ReconnectConfig = {
    backoff: "exp",
    baseMs: 500,
    maxMs: 8000,
    jitter: 0.2,
  };
  private peers: Map<string, PeerContext> = new Map();
  private peerConfig: RTCConfiguration = {
    iceServers: [{ urls: "stun:stun1.l.google.com:19302" }],
  };
  private remoteDescriptionSet: Map<string, boolean> = new Map();
  private candidateQueue: Map<string, RTCIceCandidateInit[]> = new Map();
  private candidateTypes: Array<"udp" | "tcp"> = ["udp", "tcp"];
  private activeStreams: Map<string, ActiveStreamInfo> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastReconnectAt: Map<string, number> = new Map();
  /** Consecutive reconnect attempts per stream; drives exponential backoff. */
  private reconnectAttempts: Map<string, number> = new Map();
  /** Streams with a reconnect in flight, so `reconnected` fires once per recovery. */
  private reconnectInFlight: Set<string> = new Set();
  private remoteStreams: Map<string, MediaStream> = new Map();
  private audioContext: AudioContext | null = null;
  private remoteMeters: Map<string, RemoteAudioMeter> = new Map();
  private idMapping: Record<string, Record<string, string>> = Object.create(null);
  /** Pending 500ms restart of a recovering stream, so stop()/close() can cancel it. */
  private restartTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private statsTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  /** First and previous getStats() sample per peer, for the bitrates. */
  private statsSamples: Map<string, { first: StatsSample; last: StatsSample }> = new Map();
  private waiters: Set<Waiter> = new Set();
  private socketTimer: ReturnType<typeof setTimeout> | null = null;
  private socketAttempts = 0;
  private wasOpened = false;
  private closed = false;
  private readyWaiters: Array<{ resolve: () => void; reject: (e: SDKError) => void }> = [];
  /** getUserMedia started by a publish; never rejects, publish checks for a stream afterwards. */
  private mediaReady: Promise<void> = Promise.resolve();
  /** v1 parity: ICE servers given by the user are not replaced by the server's. */
  private readonly userIceServers: boolean;

  /** Opens the signaling socket. No camera or microphone is requested here. */
  constructor(opts: WebRTCClientOptions) {
    super();
    if (!opts.websocketURL) throw new Error("websocketURL is required");
    this.sanitizeDcStrings = !!opts.sanitizeDataChannelStrings;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.log = new Logger(opts.debug ? "debug" : "info");
    this.peerConfig = { ...this.peerConfig, ...opts.peerConnectionConfig };
    this.userIceServers = !!opts.peerConnectionConfig?.iceServers;

    if (opts.reconnectConfig) {
      this.reconnectConfig = {
        backoff: opts.reconnectConfig.backoff ?? this.reconnectConfig.backoff,
        baseMs: opts.reconnectConfig.baseMs ?? this.reconnectConfig.baseMs,
        maxMs: opts.reconnectConfig.maxMs ?? this.reconnectConfig.maxMs,
        jitter: opts.reconnectConfig.jitter ?? this.reconnectConfig.jitter,
      };
    }

    this.ownsMedia = !opts.mediaManager;
    this.media =
      opts.mediaManager ??
      new MediaManager({ mediaConstraints: opts.mediaConstraints, localVideo: opts.localVideo });

    const mediaEvents = [
      "devices_updated",
      "local_tracks_changed",
      "local_track_paused",
      "local_track_resumed",
      "error",
      "screen_share_stopped",
    ] as const;
    this.mediaUnsubs = mediaEvents.map(ev =>
      this.media.on(ev, (p: unknown) => (this.emit as (e: string, p: unknown) => void)(ev, p))
    );
    this.mediaUnsubs.push(
      this.media.on("local_tracks_changed", () => {
        void this.applyLocalTracks();
      })
    );

    this.ws = new WebSocketAdaptor({
      websocketURL: opts.websocketURL,
      onEvent: (info, obj) => this.handleTransportEvent(info, obj),
      debug: opts.debug,
    });
  }

  /**
   * Resolves when the socket is open. Rejects when the current or next connection attempt fails,
   * and after close(); reconnecting goes on in the background.
   */
  async ready(): Promise<void> {
    if (this.isReady) return;
    if (this.closed) throw new SDKError("WebSocketNotConnected");
    // no reconnect scheduled (e.g. autoReconnect: false): start an attempt to wait for
    if (!this.socketTimer) this.ws?.connect();
    await new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  private settleReady(err?: SDKError): void {
    for (const waiter of this.readyWaiters.splice(0)) {
      if (err) waiter.reject(err);
      else waiter.resolve();
    }
  }

  /**
   * Publish a stream. The session is returned at once and gets every event of its stream;
   * `ready()` resolves when the server reports it live. The first publish with media opens the
   * camera and microphone, unless `media.initLocalStream()` did.
   */
  publish(streamId: string, options: PublishOptions = {}): PublishSession {
    const dataOnly = !!options.dataOnly;
    return this.startStream(PublishSession, streamId, { mode: "publish", dataOnly }, async () => {
      await this.readyToPublish(dataOnly);
      this.log.info("publish %s", streamId);
      const stream = dataOnly ? null : this.media.getLocalStream();
      return {
        command: "publish",
        streamId,
        token: options.token ?? "",
        mainTrack: options.roomId,
        streamName: options.streamName ?? "",
        metaData: options.metaData ?? "",
        role: options.role ?? "",
        subscriberId: options.subscriberId ?? "",
        subscriberCode: options.subscriberCode ?? "",
        video: !!stream && stream.getVideoTracks().length > 0,
        audio: !!stream && stream.getAudioTracks().length > 0,
      };
    });
  }

  /**
   * Play a stream or a room. The session is returned at once and gets every event of its stream;
   * `ready()` resolves when the server reports it playing. Each incoming track emits
   * `newTrackAvailable`; `remoteVideo` gets the stream's media.
   */
  play(streamId: string, options: PlayOptions = {}): PlaySession {
    const info: ActiveStreamInfo = { mode: "play", remoteVideo: options.remoteVideo };
    return this.startStream(PlaySession, streamId, info, async () => {
      await this.ready();
      this.log.info("play %s", streamId);
      return {
        command: "play",
        streamId,
        token: options.token ?? "",
        room: options.roomId ?? "",
        trackList: options.enableTracks ?? [],
        subscriberId: options.subscriberId ?? "",
        subscriberCode: options.subscriberCode ?? "",
        viewerInfo: options.metaData ?? "",
        role: options.role ?? "",
        subscriberName: options.subscriberName ?? "",
        userPublishId: options.userPublishId ?? "",
        disableTracksByDefault: options.disableTracksByDefault ?? false,
      };
    });
  }

  /** ready(), plus the local stream when publishing media; rejects with the getUserMedia error. */
  private async readyToPublish(dataOnly: boolean): Promise<void> {
    if (dataOnly) return this.ready();
    await Promise.all([this.ready(), this.mediaReady]);
    if (this.media.getLocalStream()) return;
    const attempt = this.initMedia();
    this.mediaReady = attempt.catch(() => undefined);
    await attempt;
  }

  /** getUserMedia, reporting each failure once under v1's error name, which is also the code. */
  private initMedia(): Promise<void> {
    return this.media.initLocalStream().catch((e: unknown) => {
      const { name, message } = (e ?? {}) as { name?: string; message?: string };
      const code = name && V1_MEDIA_ERRORS.includes(name) ? name : "getUserMediaIsNotAllowed";
      this.emitError(code, message);
      throw new SDKError(code, message, e);
    });
  }

  /**
   * End a stream (publish or play) at once. Resolves when the server confirms with its finished
   * notification, which is what emits publish_finished/play_finished; when the socket is down or
   * the server does not answer in time, the event is emitted locally. A stream not live yet is
   * cancelled, without a finished event. Never rejects.
   * @internal
   */
  async stop(streamId: string): Promise<void> {
    const info = this.activeStreams.get(streamId);
    if (!info?.live) return this.endStream(streamId, true);
    this.clearStream(streamId);
    if (this.ws?.isConnected()) {
      try {
        await this.request("finished", streamId, STOP_TIMEOUT_MS, { command: "stop", streamId });
        // the server's notification reached the client's listeners already
        info.session?.emit(FINISHED[info.mode], { streamId });
        return;
      } catch {
        // timeout or socket lost
      }
    }
    this.emitFinished(streamId, info.mode, info.session);
  }

  /** Clear the stream and emit its finished event locally if it was live; only a local end tells the server. */
  private endStream(streamId: string, notifyServer: boolean): void {
    const info = this.activeStreams.get(streamId);
    const mode = this.clearStream(streamId);
    if (!mode) return;
    if (notifyServer && this.ws?.isConnected()) this.sendCommand({ command: "stop", streamId });
    if (info?.live) this.emitFinished(streamId, mode, info.session);
  }

  private emitFinished(streamId: string, mode: StreamMode, session?: StreamSession): void {
    this.emit(FINISHED[mode], { streamId });
    session?.emit(FINISHED[mode], { streamId });
  }

  /**
   * Every event goes to the client, and to the active session of the stream it names. A session's
   * own end clears its stream first, so emitFinished/stop() deliver that finished event once.
   */
  override emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    super.emit(event, payload);
    const id = (payload as { streamId?: unknown } | undefined)?.streamId;
    if (typeof id !== "string") return;
    const session = this.activeStreams.get(id)?.session;
    session?.emit(event as keyof StreamEventMap, payload as StreamEventMap[keyof StreamEventMap]);
  }

  /**
   * Register the stream and its session at once, then build and send its start command; the
   * session's ready() reports the outcome. An id already active gets an ended session.
   */
  private startStream<S extends StreamSession>(
    Session: new (client: WebRTCClient, streamId: string, started: Promise<void>) => S,
    streamId: string,
    info: ActiveStreamInfo,
    command: () => Promise<Record<string, unknown>>
  ): S {
    if (this.activeStreams.has(streamId)) {
      const inUse = new SDKError("streamIdInUse", `${streamId} is already active on this client`);
      return new Session(this, streamId, Promise.reject(inUse));
    }
    this.activeStreams.set(streamId, info);
    const session = new Session(this, streamId, this.start(streamId, info, command));
    info.session = session;
    return session;
  }

  /** Send the start command and wait until the server reports the stream live. */
  private async start(
    streamId: string,
    info: ActiveStreamInfo,
    command: () => Promise<Record<string, unknown>>
  ): Promise<void> {
    try {
      const payload = await command();
      if (this.activeStreams.get(streamId) !== info) {
        throw new SDKError("stream_stopped", `${streamId} was stopped before it went live`);
      }
      info.command = payload;
      await this.request(`${info.mode}_started`, streamId, START_TIMEOUT_MS, payload);
    } catch (e) {
      // unless stop()/close() already ended it: nothing may linger, nor be recovered later
      if (this.activeStreams.get(streamId) === info) {
        this.clearStream(streamId);
        if (info.command && this.ws?.isConnected()) this.sendCommand({ command: "stop", streamId });
      }
      throw e;
    }
  }

  /** @internal */
  sessionState(session: StreamSession): SessionState {
    const { streamId } = session;
    const info = this.activeStreams.get(streamId);
    if (info?.session !== session) return "ended";
    if (!info.live) return "starting";
    return this.isReady && !this.reconnectInFlight.has(streamId) ? "live" : "reconnecting";
  }

  /** @internal */
  peerConnection(streamId: string): RTCPeerConnection | null {
    return this.peers.get(streamId)?.pc ?? null;
  }

  /** @internal */
  remoteStream(streamId: string): MediaStream | null {
    return this.remoteStreams.get(streamId) ?? null;
  }

  /**
   * Send `payload` and resolve with the server frame `key` about `id`. Rejects on an error frame
   * for `id`, after `ms`, or when the socket is lost.
   */
  private request<T>(
    key: string,
    id: string,
    ms: number,
    payload: Record<string, unknown>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = new SDKError("timeout", `no ${key} for ${id}`);
      const timer = setTimeout(() => waiter.reject(timeout), ms);
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
      };
      const waiter: Waiter = {
        key,
        id,
        resolve: frame => {
          done();
          resolve(frame as T);
        },
        reject: e => {
          done();
          reject(e);
        },
      };
      this.waiters.add(waiter);
      this.sendCommand(payload);
    });
  }

  /** Settle the waiters `match` selects: rejected with `err` when given, else resolved with `frame`. */
  private settle(match: (w: Waiter) => boolean, frame?: unknown, err?: SDKError): void {
    for (const w of this.waiters) {
      if (!match(w)) continue;
      if (err) w.reject(err);
      else w.resolve(frame);
    }
  }

  private async query<T>(key: string, id: string, command: Record<string, unknown>): Promise<T> {
    await this.ready();
    return this.request<T>(key, id, QUERY_TIMEOUT_MS, command);
  }

  /** Encoding renditions of a stream. */
  getStreamInfo(streamId: string): Promise<StreamInformation> {
    return this.query("streamInformation", streamId, { command: "getStreamInfo", streamId });
  }

  /** Broadcast object of a stream, main track or subtrack (includes metadata and relations). */
  getBroadcastObject(streamId: string): Promise<BroadcastObject> {
    return this.query("broadcastObject", streamId, { command: "getBroadcastObject", streamId });
  }

  getSubscriberCount(streamId: string): Promise<SubscriberCount> {
    return this.query("subscriberCount", streamId, { command: "getSubscriberCount", streamId });
  }

  /** Paginated subscriber list of a stream. */
  getSubscriberList(streamId: string, offset = 0, size = 50): Promise<SubscriberList> {
    const command = { command: "getSubscribers", streamId, offset, size };
    return this.query("subscriberList", streamId, command);
  }

  /** Track ids under a main track. */
  getTracks(streamId: string, token = ""): Promise<TrackList> {
    return this.query("trackList", streamId, { command: "getTrackList", streamId, token });
  }

  /** Paginated subtracks of a main track, optionally filtered by `role`. */
  getSubtracks(streamId: string, role = "", offset = 0, size = 50): Promise<SubtrackList> {
    const command = { command: "getSubtracks", streamId, role, offset, size };
    return this.query("subtrackList", streamId, command);
  }

  /** Subtrack count of a main track, filterable by role and status; answered under `mainTrack`. */
  getSubtrackCount(streamId: string, role = "", status = ""): Promise<SubtrackCount> {
    const command = { command: "getSubtracksCount", streamId, role, status };
    return this.query("subtrackCount", streamId, command);
  }

  /** Legacy room information (ids and names of the streams in the room); answered under `room`. */
  getRoomInfo(roomId: string, streamId = ""): Promise<RoomInformation> {
    const command = { command: "getRoomInfo", room: roomId, streamId };
    return this.query("roomInformation", roomId, command);
  }

  /**
   * Legacy room-join command. For multitrack conferencing, prefer {@link publish} + {@link play}.
   */
  async joinRoom(opts: RoomJoinOptions): Promise<void> {
    await this.ready();
    const payload = {
      command: "joinRoom",
      room: opts.roomId,
      mainTrack: opts.roomId,
      streamId: opts.streamId ?? "",
      mode: opts.mode ?? "multitrack",
      streamName: opts.streamName ?? "",
      role: opts.role ?? "",
      metadata: opts.metaData ?? "",
    } as Record<string, unknown>;
    this.sendCommand(payload);
  }

  /**
   * Send the legacy leave-room command. Only the command: no peer connection is closed and no
   * session ended here, stop() them for that.
   */
  async leaveRoom(roomId: string, streamId?: string): Promise<void> {
    await this.ready();
    this.sendCommand({
      command: "leaveFromRoom",
      room: roomId,
      mainTrack: roomId,
      streamId: streamId ?? "",
    });
  }

  /**
   * Register a push notification token to Ant Media Server.
   */
  registerPushNotificationToken(
    subscriberId: string,
    authToken: string,
    pushToken: string,
    tokenType: "fcm" | "apn"
  ): void {
    this.sendCommand({
      command: "registerPushNotificationToken",
      subscriberId,
      token: authToken,
      pnsRegistrationToken: pushToken,
      pnsType: tokenType,
    });
  }

  /**
   * Send push notification to users.
   */
  sendPushNotification(
    subscriberId: string,
    authToken: string,
    pushNotificationContent: Record<string, unknown>,
    subscriberIdsToNotify: string[]
  ): void {
    if (typeof pushNotificationContent !== "object") {
      throw new Error("pushNotificationContent must be an object");
    }
    if (!Array.isArray(subscriberIdsToNotify)) {
      throw new Error("subscriberIdsToNotify must be an array");
    }
    this.sendCommand({
      command: "sendPushNotification",
      subscriberId,
      token: authToken,
      pushNotificationContent,
      subscriberIdsToNotify,
    });
  }

  /**
   * Send push notification to a topic.
   */
  sendPushNotificationToTopic(
    subscriberId: string,
    authToken: string,
    pushNotificationContent: Record<string, unknown>,
    topic: string
  ): void {
    if (typeof pushNotificationContent !== "object") {
      throw new Error("pushNotificationContent must be an object");
    }
    this.sendCommand({
      command: "sendPushNotification",
      subscriberId,
      token: authToken,
      pushNotificationContent,
      topic,
    });
  }

  /** @internal */
  async forceStreamQuality(streamId: string, height: number): Promise<void> {
    await this.ready();
    this.sendCommand({
      command: "forceStreamQuality",
      streamId,
      streamHeight: height,
    });
  }

  /** @internal */
  async changeBandwidth(streamId: string, bandwidth: number | "unlimited"): Promise<void> {
    const info = this.activeStreams.get(streamId);
    if (info) info.bandwidth = bandwidth;
    const ctx = this.peers.get(streamId);
    if (!ctx) return;
    const sender = ctx.videoSender || ctx.pc.getSenders().find(s => s.track?.kind === "video");
    if (!sender) return;
    const params = sender.getParameters();
    // some browsers report none before negotiation
    if (!params.encodings?.length) params.encodings = [{}];
    if (bandwidth === "unlimited") {
      delete (params.encodings[0] as Record<string, unknown>).maxBitrate;
    } else {
      (params.encodings[0] as Record<string, unknown>).maxBitrate = bandwidth * 1000;
    }
    try {
      await sender.setParameters(params);
    } catch (e) {
      this.log.warn("setParameters(maxBitrate) failed", e);
    }
  }

  /** @internal */
  async setDegradationPreference(
    streamId: string,
    preference: RTCDegradationPreference
  ): Promise<void> {
    const info = this.activeStreams.get(streamId);
    if (info) info.degradation = preference;
    const ctx = this.peers.get(streamId);
    if (!ctx) return;
    const sender = ctx.videoSender || ctx.pc.getSenders().find(s => s.track?.kind === "video");
    if (!sender) return;
    const params = sender.getParameters();
    try {
      (params as unknown as { degradationPreference?: string }).degradationPreference = preference;
      await sender.setParameters(params);
      this.log.info("Degradation Preference set to %s", preference);
    } catch (e) {
      this.log.warn("setParameters(degradationPreference) failed", e);
    }
  }

  /** @internal */
  toggleVideo(streamId: string, trackId: string, enabled: boolean): void {
    this.sendCommand({ command: "toggleVideo", streamId, trackId, enabled });
  }

  /** @internal */
  toggleAudio(streamId: string, trackId: string, enabled: boolean): void {
    this.sendCommand({ command: "toggleAudio", streamId, trackId, enabled });
  }

  /** @internal */
  updateStreamMetaData(streamId: string, metaData: unknown): void {
    this.sendCommand({ command: "updateStreamMetaData", streamId, metaData });
  }

  /** @internal */
  async enableTrack(mainTrackId: string, trackId: string, enabled: boolean): Promise<void> {
    await this.ready();
    this.sendCommand({ command: "enableTrack", streamId: mainTrackId, trackId, enabled });
  }

  /** @internal */
  async requestVideoTrackAssignments(streamId: string): Promise<void> {
    await this.ready();
    this.sendCommand({ command: "getVideoTrackAssignmentsCommand", streamId });
  }

  /** @internal */
  async assignVideoTrack(streamId: string, videoTrackId: string, enabled: boolean): Promise<void> {
    await this.ready();
    this.sendCommand({ command: "assignVideoTrackCommand", streamId, videoTrackId, enabled });
  }

  /** @internal */
  async updateVideoTrackAssignments(streamId: string, offset: number, size: number): Promise<void> {
    await this.ready();
    this.sendCommand({ command: "updateVideoTrackAssignmentsCommand", streamId, offset, size });
  }

  /** @internal */
  async setMaxVideoTrackCount(streamId: string, maxTrackCount: number): Promise<void> {
    await this.ready();
    this.sendCommand({ command: "setMaxVideoTrackCountCommand", streamId, maxTrackCount });
  }

  private cancelReconnect(streamId: string): void {
    const timer = this.reconnectTimers.get(streamId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(streamId);
    }
  }

  private cancelRestart(streamId: string): void {
    const timer = this.restartTimers.get(streamId);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(streamId);
    }
  }

  /** Close the peer connection and drop its negotiation state; the stream stays active. */
  private closePeer(streamId: string): void {
    const ctx = this.peers.get(streamId);
    if (ctx) {
      try {
        ctx.pc.close();
      } catch (e) {
        this.log.warn("pc.close failed", e);
      }
      this.peers.delete(streamId);
    }
    this.remoteDescriptionSet.delete(streamId);
    this.candidateQueue.delete(streamId);
    this.statsSamples.delete(streamId);
    delete this.idMapping[streamId];
  }

  /** Drop every per-stream map entry and timer of a stream and fail its pending start; returns its mode. */
  private clearStream(streamId: string): StreamMode | undefined {
    const mode = this.peers.get(streamId)?.mode ?? this.activeStreams.get(streamId)?.mode;
    this.closePeer(streamId);
    this.activeStreams.delete(streamId);
    this.remoteStreams.delete(streamId);
    this.lastReconnectAt.delete(streamId);
    this.reconnectAttempts.delete(streamId);
    this.reconnectInFlight.delete(streamId);
    this.cancelReconnect(streamId);
    this.cancelRestart(streamId);
    this.disableStats(streamId);
    this.disableRemoteAudioLevel(streamId);
    const stopped = new SDKError("stream_stopped", `${streamId} was stopped before it went live`);
    this.settle(w => w.id === streamId && STARTED.includes(w.key), undefined, stopped);
    return mode;
  }

  /**
   * One stats sample of the stream's peer; null without a peer or when the browser fails.
   * @internal
   */
  async getStats(streamId: string): Promise<PeerStats | null> {
    const pc = this.peers.get(streamId)?.pc;
    if (!pc) return null;
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return null;
    }
    const ps = new PeerStats(streamId);
    const sample: StatsSample = { t: 0, sent: 0, recv: 0 };
    report.forEach(r => {
      if (r.type === "outbound-rtp") {
        const s: RTCOutboundRtpStreamStats = r;
        sample.sent += s.bytesSent || 0;
        sample.t = s.timestamp || sample.t;
        if (s.kind === "audio") ps.audioPacketsSent = s.packetsSent;
        if (s.kind === "video") {
          ps.videoPacketsSent = s.packetsSent;
          ps.frameWidth = s.frameWidth ?? ps.frameWidth;
          ps.frameHeight = s.frameHeight ?? ps.frameHeight;
          ps.framesEncoded = s.framesEncoded ?? ps.framesEncoded;
        }
      } else if (r.type === "inbound-rtp") {
        const s: RTCInboundRtpStreamStats = r;
        sample.recv += s.bytesReceived || 0;
        sample.t = s.timestamp || sample.t;
        // a viewer's own loss and jitter; remote-inbound-rtp below is the publisher's view
        if (s.kind === "audio") {
          ps.audioPacketsReceived = s.packetsReceived;
          ps.audioPacketsLost = s.packetsLost;
          ps.audioJitter = s.jitter;
        }
        if (s.kind === "video") {
          ps.videoPacketsReceived = s.packetsReceived;
          ps.videoPacketsLost = s.packetsLost;
          ps.videoJitter = s.jitter;
          ps.frameWidth = s.frameWidth ?? ps.frameWidth;
          ps.frameHeight = s.frameHeight ?? ps.frameHeight;
          ps.framesDecoded = s.framesDecoded ?? ps.framesDecoded;
          ps.framesDropped = s.framesDropped ?? ps.framesDropped;
          ps.framesReceived = s.framesReceived ?? ps.framesReceived;
        }
      } else if (r.type === "remote-inbound-rtp") {
        // lib.dom has no type for it: received-RTP fields plus roundTripTime
        const s: RTCReceivedRtpStreamStats & { roundTripTime?: number } = r;
        if (s.kind === "audio") {
          ps.audioPacketsLost = s.packetsLost;
          ps.audioRoundTripTime = s.roundTripTime;
          ps.audioJitter = s.jitter;
        } else if (s.kind === "video") {
          ps.videoPacketsLost = s.packetsLost;
          ps.videoRoundTripTime = s.roundTripTime;
          ps.videoJitter = s.jitter;
        }
      } else if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) {
        // the pair in use; other succeeded pairs are only candidates
        const s: RTCIceCandidatePairStats = r;
        if (s.availableOutgoingBitrate != null) {
          ps.availableOutgoingBitrateKbps = s.availableOutgoingBitrate / 1000;
        }
        ps.currentRoundTripTime = s.currentRoundTripTime;
      }
    });
    ps.totalBytesSent = sample.sent;
    ps.totalBytesReceived = sample.recv;
    ps.currentTimestamp = sample.t;
    // as v1: 8 * bytes / ms = kbit/s, current against the previous sample, average the first
    const prev = this.statsSamples.get(streamId);
    if (prev && sample.t > prev.last.t) {
      const kbps = (bytes: number, ms: number) => Math.floor((8 * bytes) / ms);
      ps.currentOutgoingBitrate = kbps(sample.sent - prev.last.sent, sample.t - prev.last.t);
      ps.currentIncomingBitrate = kbps(sample.recv - prev.last.recv, sample.t - prev.last.t);
      ps.averageOutgoingBitrate = kbps(sample.sent - prev.first.sent, sample.t - prev.first.t);
      ps.averageIncomingBitrate = kbps(sample.recv - prev.first.recv, sample.t - prev.first.t);
    }
    // a peer closed meanwhile has no samples to keep
    if (this.peers.get(streamId)?.pc === pc) {
      this.statsSamples.set(streamId, { first: prev?.first ?? sample, last: sample });
    }
    this.emit("updated_stats", ps);
    return ps;
  }

  /** @internal */
  enableStats(streamId: string, periodMs = 5000): void {
    if (this.statsTimers.has(streamId)) return;
    this.statsTimers.set(
      streamId,
      setInterval(() => {
        void this.getStats(streamId);
      }, periodMs)
    );
  }

  /** @internal */
  disableStats(streamId: string): void {
    const timer = this.statsTimers.get(streamId);
    if (timer) {
      clearInterval(timer);
      this.statsTimers.delete(streamId);
    }
  }

  /** @internal */
  async sendData(streamId: string, data: string | ArrayBuffer): Promise<void> {
    const dc = this.peers.get(streamId)?.dc;
    // checked again after waiting: the channel may close while its buffer drains
    const open = (): RTCDataChannel => {
      if (dc?.readyState !== "open") {
        throw new SDKError("data_channel_not_available", `no open data channel for ${streamId}`);
      }
      return dc;
    };
    if (typeof data === "string") {
      open().send(data);
      return;
    }
    const channel = open();
    const CHUNK_SIZE = 16000;
    const length = data.byteLength;
    const token = Math.floor(Math.random() * 999999) | 0;
    const header = new Int32Array(2);
    header[0] = token;
    header[1] = length;
    channel.send(header);

    let sent = 0;
    channel.bufferedAmountLowThreshold = 1 << 20;
    while (sent < length) {
      const size = Math.min(length - sent, CHUNK_SIZE);
      const buffer = new Uint8Array(size + 4);
      const tokenArray = new Int32Array(1);
      tokenArray[0] = token;
      buffer.set(new Uint8Array(tokenArray.buffer, 0, 4), 0);
      const chunk = new Uint8Array(data, sent, size);
      buffer.set(chunk, 4);
      if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
        // a close ends the wait too; open() then rejects
        await new Promise<void>(resolve => {
          const done = () => {
            channel.removeEventListener("bufferedamountlow", done);
            channel.removeEventListener("close", done);
            resolve();
          };
          channel.addEventListener("bufferedamountlow", done);
          channel.addEventListener("close", done);
        });
      }
      open().send(buffer);
      sent += size;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.socketTimer) {
      clearTimeout(this.socketTimer);
      this.socketTimer = null;
    }
    // also streams waiting for the server's start or mid-restart
    for (const streamId of new Set([...this.peers.keys(), ...this.activeStreams.keys()])) {
      this.endStream(streamId, true);
    }
    for (const streamId of Array.from(this.statsTimers.keys())) {
      this.disableStats(streamId);
    }
    this.failWaiting();
    try {
      this.ws?.close();
    } catch (e) {
      this.log.warn("ws close failed", e);
    }
    for (const unsub of this.mediaUnsubs) unsub();
    for (const streamId of Array.from(this.remoteMeters.keys())) {
      this.disableRemoteAudioLevel(streamId);
    }
    try {
      this.audioContext?.close().catch(e => this.log.warn("audio context close failed", e));
    } catch (e) {
      this.log.warn("audio context close failed", e);
    }
    this.audioContext = null;
    if (this.ownsMedia) this.media.dispose();
    this.emit("closed", undefined);
  }

  /** @internal */
  async enableRemoteAudioLevel(
    streamId: string,
    callback: (level: number) => void,
    periodMs = 200
  ): Promise<void> {
    const stream = this.remoteStreams.get(streamId);
    if (!stream) return;
    if (!this.audioContext) this.audioContext = new AudioContext();
    const ctx = this.audioContext;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    if (this.remoteMeters.has(streamId)) this.disableRemoteAudioLevel(streamId);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      try {
        callback(rms);
      } catch (e) {
        this.log.warn("remote audio level callback failed", e);
      }
    }, periodMs);
    this.remoteMeters.set(streamId, { analyser, timer, data, source });
  }

  /** @internal */
  disableRemoteAudioLevel(streamId: string): void {
    const meter = this.remoteMeters.get(streamId);
    if (!meter) return;
    clearInterval(meter.timer);
    try {
      meter.source.disconnect();
    } catch (e) {
      this.log.warn("remote audio source disconnect failed", e);
    }
    try {
      meter.analyser.disconnect();
    } catch (e) {
      this.log.warn("remote audio analyser disconnect failed", e);
    }
    this.remoteMeters.delete(streamId);
  }

  private sendCommand(payload: Record<string, unknown>): void {
    // the command name only: payloads may carry a token
    if (!this.ws?.send(JSON.stringify(payload))) {
      this.emitError("WebSocketNotConnected", { command: payload.command });
    }
  }

  private emitError(error: ErrorCode, message?: unknown, streamId?: string): void {
    this.emit("error", { error, message, streamId });
  }

  private onStartCommand(streamId: string): void {
    this.startPublishing(streamId).catch((e: unknown) => {
      this.log.warn("start publishing failed", e);
      this.failStream(e instanceof SDKError ? e.code : "notSetLocalDescription", e, streamId);
    });
  }

  private createPeer(streamId: string, mode: StreamMode = "publish"): RTCPeerConnection {
    const existingCtx = this.peers.get(streamId);
    if (existingCtx && existingCtx.pc) {
      existingCtx.mode = mode;
      this.peers.set(streamId, existingCtx);
      return existingCtx.pc;
    }
    const pc = new RTCPeerConnection(this.peerConfig);
    pc.onicecandidate = ev => {
      if (ev.candidate && this.ws) {
        const cand = ev.candidate.candidate ?? "";
        const protocolSupported = this.candidateTypes.some(p => cand.toLowerCase().includes(p));
        if (!protocolSupported && cand !== "") {
          this.log.debug("Skipping candidate due to protocol filter: %s", cand);
          return;
        }
        const msg = {
          command: "takeCandidate",
          streamId,
          label: ev.candidate.sdpMLineIndex ?? 0,
          id: ev.candidate.sdpMid,
          candidate: ev.candidate.candidate,
        };
        this.sendCommand(msg);
      }
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.log.info("ice state %s %s", streamId, state);
      this.emit("ice_connection_state_changed", { state, streamId });
      if (state === "connected" || state === "completed") {
        this.onIceRecovered(streamId);
        return;
      }
      if (!this.autoReconnect) return;
      if (!this.activeStreams.has(streamId)) return;
      if (state === "failed" || state === "closed") {
        this.reconnectIfRequired(streamId, 0, false);
      } else if (state === "disconnected") {
        this.reconnectIfRequired(streamId, 3000, false);
      }
    };

    pc.ontrack = (event: RTCTrackEvent) => {
      this.log.debug("ontrack %s", streamId);
      const stream = event.streams[0];
      const remoteVideo = this.activeStreams.get(streamId)?.remoteVideo;
      if (remoteVideo && remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream;
      if (stream) this.remoteStreams.set(streamId, stream);

      const mid = event.transceiver && event.transceiver.mid;
      const mapping = this.idMapping[streamId] || {};
      const mappedId = typeof mid === "string" ? mapping[mid] : undefined;
      const trackId = mappedId || event.track.id;
      const payload = { stream, track: event.track, streamId, trackId };
      this.emit("newTrackAvailable", payload);
    };

    const existing = this.peers.get(streamId) ?? { pc };
    existing.pc = pc;
    existing.mode = mode;
    this.peers.set(streamId, existing as PeerContext);
    return pc;
  }

  private setupDataChannel(streamId: string, dc: RTCDataChannel): void {
    const ctx = this.peers.get(streamId);
    if (ctx) ctx.dc = dc;
    try {
      dc.binaryType = "arraybuffer";
    } catch (e) {
      this.log.warn("setting binaryType failed", e);
    }
    dc.onerror = error => {
      this.log.warn("data channel error", error);
      if (dc.readyState !== "closed") {
        this.emitError("data_channel_error", error, streamId);
      }
    };
    dc.onopen = () => {
      this.log.debug("data channel opened %s", streamId);
      this.emit("data_channel_opened", { streamId });
    };
    dc.onclose = () => {
      this.log.debug("data channel closed %s", streamId);
      this.emit("data_channel_closed", { streamId });
    };
    // binary transfers of this channel by token; dropped with the channel
    const transfers = new Map<number, ChunkState>();
    dc.onmessage = event => {
      const raw = event.data;
      const processBuffer = (u8: Uint8Array) => {
        const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const token = u8.byteLength >= 4 ? view.getInt32(0, true) : undefined;
        const st = token === undefined ? undefined : transfers.get(token);
        // 8 bytes are a header, unless the token is in flight: then a chunk with 4 data bytes
        if (token !== undefined && !st && u8.byteLength === 8) {
          const total = view.getInt32(4, true);
          const now = Date.now();
          // lazy sweep: drop reassembly state left behind by interrupted transfers
          for (const [t, s] of transfers) {
            if (now - s.ts > CHUNK_TTL_MS) transfers.delete(t);
          }
          if (total >= 1 && total <= MAX_TRANSFER_BYTES) {
            transfers.set(token, { expected: total, received: 0, buffers: [], ts: now });
          }
          return;
        }
        if (token === undefined || !st) {
          this.emit("data_received", {
            streamId,
            data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer,
          });
          return;
        }
        const dataPart = u8.subarray(4);
        st.received += dataPart.byteLength;
        // more than the header declared: drop the transfer
        if (st.received > st.expected) {
          transfers.delete(token);
          return;
        }
        st.buffers.push(dataPart);
        st.ts = Date.now();
        if (st.received === st.expected) {
          const full = new Uint8Array(st.expected);
          let offset = 0;
          for (const b of st.buffers) {
            full.set(b, offset);
            offset += b.byteLength;
          }
          transfers.delete(token);
          this.emit("data_received", { streamId, data: full.buffer });
        }
      };

      if (typeof raw === "string") {
        const text = this.sanitizeDcStrings ? raw.replace(/</g, "&lt;").replace(/>/g, "&gt;") : raw;
        this.emit("data_received", { streamId, data: text });
        // the server's own frames also get typed events
        let frame: { eventType?: unknown } | null = null;
        try {
          frame = JSON.parse(raw);
        } catch {
          return;
        }
        if (frame?.eventType === "VIDEO_TRACK_ASSIGNMENT_LIST") {
          this.emit("video_track_assignments", frame as VideoTrackAssignmentList);
        } else if (frame?.eventType === "TRACK_LIST_UPDATED") {
          this.emit("track_list_updated", frame as TrackListUpdated);
        }
        return;
      }
      if (typeof Blob !== "undefined" && raw instanceof Blob) {
        raw
          .arrayBuffer()
          .then(ab => processBuffer(new Uint8Array(ab)))
          .catch(() => this.emitError("data_channel_blob_parse_failed", raw, streamId));
        return;
      }
      if (raw instanceof ArrayBuffer) {
        processBuffer(new Uint8Array(raw));
        return;
      }
      if (ArrayBuffer.isView(raw)) {
        const view = raw as ArrayBufferView;
        processBuffer(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        return;
      }
      this.emit("data_received", { streamId, data: raw });
    };
  }

  private async startPublishing(streamId: string): Promise<void> {
    const pc = this.peers.get(streamId)?.pc ?? this.createPeer(streamId);
    const info = this.activeStreams.get(streamId);
    const dataOnly = !!info?.dataOnly;
    const stream = dataOnly ? null : this.media.getLocalStream();
    if (!stream && !dataOnly) throw new SDKError("no_local_stream");

    if (stream && pc.getSenders().length === 0) {
      for (const track of stream.getTracks()) {
        const sender = pc.addTrack(track, stream);
        if (track.kind === "video") this.peers.get(streamId)!.videoSender = sender;
        if (track.kind === "audio") this.peers.get(streamId)!.audioSender = sender;
      }
    } else {
      const ctx = this.peers.get(streamId);
      if (ctx) {
        const senders = pc.getSenders();
        ctx.videoSender = ctx.videoSender || senders.find(s => s.track?.kind === "video");
        ctx.audioSender = ctx.audioSender || senders.find(s => s.track?.kind === "audio");
      }
    }
    // a recovered peer is new: the stream's sender settings go on it again
    if (info?.bandwidth !== undefined) await this.changeBandwidth(streamId, info.bandwidth);
    if (info?.degradation) await this.setDegradationPreference(streamId, info.degradation);

    try {
      const dc = pc.createDataChannel
        ? pc.createDataChannel(streamId, { ordered: true })
        : undefined;
      if (dc) this.setupDataChannel(streamId, dc);
    } catch (e) {
      this.log.warn("createDataChannel not supported", e);
    }
    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    this.sendTakeConfiguration(streamId, offer.type, offer.sdp ?? "");
  }

  private sendTakeConfiguration(streamId: string, type: RTCSdpType, sdp: string): void {
    const msg = { command: "takeConfiguration", streamId, type, sdp };
    this.sendCommand(msg);
    // publish_started is emitted only when the server confirms the stream is live
  }

  private async applyLocalTracks(): Promise<void> {
    const stream = this.media.getLocalStream();
    if (!stream) return;
    for (const [streamId, ctx] of this.peers) {
      // play peers receive only, data-only peers send no media
      if (ctx.mode !== "publish" || this.activeStreams.get(streamId)?.dataOnly) continue;
      const senders = ctx.pc.getSenders();
      for (const track of stream.getTracks()) {
        const key = track.kind === "video" ? "videoSender" : "audioSender";
        const sender = ctx[key] || senders.find(s => s.track && s.track.kind === track.kind);
        try {
          if (sender && sender.replaceTrack) {
            await sender.replaceTrack(track);
            ctx[key] = sender;
          } else {
            ctx[key] = ctx.pc.addTrack(track, stream);
          }
        } catch (e) {
          this.log.warn("applying local track failed", e);
        }
      }
    }
  }

  private takeConfiguration(obj: Record<string, unknown>): void {
    const payload = obj as unknown as TakeConfigurationPayload;
    const { streamId, sdp, type } = payload;

    this.log.debug("takeConfiguration %s %s", streamId, type);

    const mapping = payload.idMapping || payload.streamTrackIds;

    if (mapping) {
      this.idMapping[streamId] = mapping;
    }

    if (type === "answer") {
      const ctx = this.peers.get(streamId);
      if (ctx) {
        ctx.pc
          .setRemoteDescription(new RTCSessionDescription({ type, sdp }))
          .then(() => this.flushCandidates(streamId, ctx.pc))
          .catch(e => this.failStream("notSetRemoteDescription", e, streamId));
      }
    } else if (type === "offer") {
      const pc = this.createPeer(streamId, "play");
      // Set up data channel for play mode like the original WebRTCAdaptor
      pc.ondatachannel = ev => {
        this.setupDataChannel(streamId, ev.channel);
      };
      pc.setRemoteDescription(new RTCSessionDescription({ type, sdp })).then(
        async () => {
          try {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendTakeConfiguration(streamId, answer.type, answer.sdp ?? "");
          } catch (e) {
            this.failStream("notSetLocalDescription", e, streamId);
            return;
          }
          this.flushCandidates(streamId, pc);
        },
        e => this.failStream("notSetRemoteDescription", e, streamId)
      );
    }
  }

  private takeCandidate(obj: Record<string, unknown>): void {
    const { streamId, label, id, candidate } = obj as unknown as TakeCandidatePayload;
    this.log.debug("takeCandidate %s", streamId);

    const ice: RTCIceCandidateInit = { sdpMLineIndex: label ?? undefined, sdpMid: id, candidate };
    const ctx = this.peers.get(streamId);

    if (ctx) {
      if (this.remoteDescriptionSet.get(streamId)) {
        this.addCandidate(ctx.pc, ice);
      } else {
        const q = this.candidateQueue.get(streamId) ?? [];
        q.push(ice);
        this.candidateQueue.set(streamId, q);
      }
    }
  }

  /** Remote description applied: candidates go straight to the peer now, queued ones first. */
  private flushCandidates(streamId: string, pc: RTCPeerConnection): void {
    this.remoteDescriptionSet.set(streamId, true);
    for (const c of this.candidateQueue.get(streamId) ?? []) this.addCandidate(pc, c);
    this.candidateQueue.set(streamId, []);
  }

  private addCandidate(pc: RTCPeerConnection, ice: RTCIceCandidateInit): void {
    const failed = (e: unknown) => this.log.warn("addIceCandidate failed", e);
    try {
      // the constructor throws on a malformed candidate
      pc.addIceCandidate(new RTCIceCandidate(ice)).catch(failed);
    } catch (e) {
      failed(e);
    }
  }

  private handleTransportEvent(info: string, obj?: unknown): void {
    if (info === "initialized") {
      this.isReady = true;
      this.socketAttempts = 0;
      const reopened = this.wasOpened;
      this.wasOpened = true;
      this.log.info("adaptor initialized");

      for (const init of reopened ? [] : WebRTCClient.pluginInitMethods) {
        try {
          init(this);
        } catch (e) {
          this.log.warn("plugin init failed", e);
        }
      }

      if (!this.userIceServers) this.sendCommand({ command: "getIceServerConfig" });
      this.emit("initialized", undefined);
      this.settleReady();
      // the server dropped our streams with the old socket; a start in flight failed with it
      if (reopened) {
        for (const [streamId, info] of this.activeStreams) {
          if (info.live) this.reconnectIfRequired(streamId, 0, true);
        }
      }
      return;
    } else if (info === "start") {
      const { streamId } = obj as { streamId: string };
      this.log.debug("start received for %s", streamId);
      this.onStartCommand(streamId);
    } else if (info === "takeConfiguration") {
      this.takeConfiguration(obj as Record<string, unknown>);
    } else if (info === "takeCandidate") {
      this.takeCandidate(obj as Record<string, unknown>);
    } else if (info === "iceServerConfig") {
      const cfg = obj as IceServerConfigPayload;
      if (cfg.stunServerUri && !this.userIceServers) {
        if (cfg.stunServerUri.startsWith("turn:")) {
          this.peerConfig.iceServers = [
            { urls: "stun:stun1.l.google.com:19302" },
            {
              urls: cfg.stunServerUri,
              username: cfg.turnServerUsername ?? "",
              credential: cfg.turnServerCredential ?? "",
            },
          ];
        } else if (cfg.stunServerUri.startsWith("stun:")) {
          this.peerConfig.iceServers = [{ urls: cfg.stunServerUri }];
        }
        this.log.info("updated ice servers");
      }
    } else if (info === "error") {
      this.onErrorFrame(obj as ErrorFrame);
    } else if (info === "stop") {
      const { streamId } = obj as { streamId: string };
      this.log.info("stop received for %s", streamId);
      this.endStream(streamId, false);
    } else if (info === "roomInformation") {
      // arrives as a top-level command, not as a notification definition
      this.emit("room_information", obj as RoomInformation);
    } else if (info === "streamInformation") {
      this.emit("stream_information", obj as StreamInformation);
    } else if (info === "trackList") {
      this.emit("track_list", obj as TrackList);
    } else if (info === "notification") {
      const payload = obj as NotificationPayload;
      const def = payload.definition || "";
      const streamId = payload.streamId || "";

      if (def === "publish_started" || def === "play_started") {
        const info = this.activeStreams.get(streamId);
        // live before the event, so its listeners can use the session
        if (info && `${info.mode}_started` === def) info.live = true;
        this.emit(def, { streamId });
      }
      // a recovery's own stop is answered too; the app does not see that one
      const finished = def === "publish_finished" || def === "play_finished";
      if (finished && !this.reconnectInFlight.has(streamId)) {
        this.emit(def, { streamId });
        this.settle(w => w.key === "finished" && w.id === streamId);
      }
      if (def === "subscriberCount") this.emit("subscriber_count", obj as SubscriberCount);
      if (def === "subscriberList") this.emit("subscriber_list", obj as SubscriberList);
      if (def === "broadcastObject") this.emit("broadcast_object", obj as BroadcastObject);
      if (def === "subtrackList") this.emit("subtrack_list", obj as SubtrackList);
      if (def === "subtrackCount") this.emit("subtrack_count", obj as SubtrackCount);
      if (def === "joinedTheRoom") this.emit("room_joined", obj as RoomJoined);
      // server constant is leavedFromRoom; the older spelling is accepted defensively
      if (def === "leavedFromRoom" || def === "leavedTheRoom") {
        this.emit("room_left", obj as RoomLeft);
      }
      if (def) this.emit(`notification:${def}`, payload);
      if (def === "server_will_stop") {
        this.emit("server_will_stop", payload);
        // v1 parity: drop the socket, the reconnect loop brings it back
        this.ws?.close();
        this.onSocketLost(undefined);
        return;
      }
    } else if (info === "closed") {
      this.onSocketLost(obj);
      return;
    }

    // started notifications and query responses answer a waiting command
    const frame = (obj ?? {}) as { definition?: string; [id: string]: unknown };
    const key = info === "notification" ? frame.definition : info;
    // subtrackCount names its stream mainTrack, roomInformation names it room
    const id = frame.streamId || frame.mainTrack || frame.room;
    this.settle(w => w.key === key && w.id === id, obj);
  }

  /** Server error frame: stream errors carry streamId, room errors room, others nothing. */
  private onErrorFrame(frame: ErrorFrame): void {
    const starts = [...this.waiters].filter(w => STARTED.includes(w.key));
    // without an id it can only be meant for a start, and only if a single one is waiting
    const lone = starts.length === 1 ? starts[0].id : undefined;
    this.failStream(frame.definition, frame, frame.streamId, frame.streamId || frame.room || lone);
  }

  /**
   * Report a failure of a stream, detected here or by the server, and fail the commands
   * waiting on `id`; a pending start then cleans the stream up.
   */
  private failStream(error: ErrorCode, cause: unknown, streamId?: string, id = streamId): void {
    this.emitError(error, cause, streamId);
    if (id) this.settle(w => w.id === id, undefined, new SDKError(error, undefined, cause));
  }

  /** Socket down: ready() waiters and every command waiting for an answer fail. */
  private failWaiting(): void {
    this.isReady = false;
    const lost = new SDKError("WebSocketNotConnected");
    this.settleReady(lost);
    this.settle(() => true, undefined, lost);
  }

  /** Socket gone without close(): fail what waits on it, tell the app, reconnect with backoff. */
  private onSocketLost(ev: unknown): void {
    this.failWaiting();
    // live streams recover from now on; their restart after the reopen announces nothing more
    if (this.autoReconnect && !this.closed) {
      for (const [streamId, info] of this.activeStreams) {
        if (info.live) this.beginRecovery(streamId);
      }
    }
    this.emit("closed", ev);
    if (!this.autoReconnect || this.closed || this.socketTimer) return;
    this.socketTimer = setTimeout(() => {
      this.socketTimer = null;
      this.ws?.connect();
    }, this.computeNextDelay(this.socketAttempts++));
  }

  /** Mark an active stream recovering and announce it, unless a recovery is already in flight. */
  private beginRecovery(streamId: string): void {
    const mode = this.activeStreams.get(streamId)?.mode;
    if (!mode || this.reconnectInFlight.has(streamId)) return;
    // recovering before the event, so its listeners see the session reconnecting
    this.reconnectInFlight.add(streamId);
    if (mode === "publish") this.emit("reconnection_attempt_for_publisher", { streamId });
    else this.emit("reconnection_attempt_for_player", { streamId });
  }

  /** ICE reached a healthy state: drop any scheduled teardown and close out a recovery. */
  private onIceRecovered(streamId: string): void {
    this.cancelReconnect(streamId);
    this.reconnectAttempts.delete(streamId);
    if (this.reconnectInFlight.delete(streamId)) {
      this.log.info("stream %s recovered", streamId);
      this.emit("reconnected", { streamId });
    }
  }

  private reconnectIfRequired(streamId: string, delayMs = 3000, forceReconnect = false): void {
    if (!this.autoReconnect) return;
    if (!this.activeStreams.has(streamId)) return;
    if (forceReconnect) this.cancelReconnect(streamId);
    else if (this.reconnectTimers.has(streamId)) return;
    const now = Date.now();
    const last = this.lastReconnectAt.get(streamId) ?? 0;
    // the caller's delay is a floor (disconnected waits longer than failed); backoff grows on top
    let floor = delayMs;
    if (!forceReconnect && now - last < 1000) {
      floor = Math.max(floor, 1000);
    }
    // one attempt event per recovery; watchdog re-arms stay silent
    this.beginRecovery(streamId);
    const nextDelay = Math.max(
      floor,
      this.computeNextDelay(this.reconnectAttempts.get(streamId) ?? 0)
    );
    this.reconnectAttempts.set(streamId, (this.reconnectAttempts.get(streamId) ?? 0) + 1);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(streamId);
      this.tryAgain(streamId, forceReconnect);
    }, nextDelay);
    this.reconnectTimers.set(streamId, timer);
  }

  private computeNextDelay(attempts: number): number {
    const { backoff, baseMs, maxMs, jitter } = this.reconnectConfig;
    let next =
      backoff === "exp" ? Math.min(maxMs, baseMs * Math.pow(2, attempts)) : Math.min(maxMs, baseMs);
    if (jitter > 0) {
      const rand = 1 + (Math.random() * 2 - 1) * jitter;
      next = Math.max(0, Math.floor(next * rand));
    }
    return next;
  }

  private tryAgain(streamId: string, forceReconnect: boolean): void {
    if (!this.activeStreams.has(streamId)) return;
    // socket down: every active stream is restarted once it is back
    if (!this.ws?.isConnected()) return;
    // v1 parity (webrtc_adaptor.js:746): never tear down a stream that healed or is still negotiating;
    // no peer yet counts as unhealthy
    const state = this.peers.get(streamId)?.pc.iceConnectionState;
    if (
      !forceReconnect &&
      (state === "checking" || state === "connected" || state === "completed")
    ) {
      this.log.info("skipping reconnect for %s, ice state is %s", streamId, state);
      return;
    }
    this.lastReconnectAt.set(streamId, Date.now());
    if (forceReconnect) {
      this.log.info("Force reconnect requested for %s", streamId);
    }
    // recovery teardown: unlike stop(), the stream stays active and the app is not told
    this.closePeer(streamId);
    this.sendCommand({ command: "stop", streamId });
    this.reconnectInFlight.add(streamId);
    this.cancelRestart(streamId);
    this.restartTimers.set(
      streamId,
      setTimeout(() => {
        this.restartTimers.delete(streamId);
        const info = this.activeStreams.get(streamId);
        if (!info?.command) return;
        // no pending start: a recovery that fails is retried by the watchdog below
        this.log.info("restarting %s", streamId);
        this.sendCommand(info.command);
        // v1 parity: re-arm after every restart until ICE connects
        this.reconnectIfRequired(streamId, 3000);
      }, 500)
    );
  }
}
