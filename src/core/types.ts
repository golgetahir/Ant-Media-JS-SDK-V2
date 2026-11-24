/** Options of a {@link WebRTCClient}; what describes one stream goes to publish() or play(). */
export interface WebRTCClientOptions {
  /** WebSocket signaling URL (e.g. wss://host:5443/App/websocket); required */
  websocketURL: string;
  /** Default media constraints used for getUserMedia */
  mediaConstraints?: MediaStreamConstraints;
  /** Local preview element for publisher (srcObject will be assigned) */
  localVideo?: HTMLVideoElement | null;
  /** Optional preconfigured MediaManager instance for advanced integrations */
  mediaManager?: import("./media-manager.js").MediaManager;
  /** Enable verbose logging */
  debug?: boolean;
  /** Enable automatic reconnection on ICE failure/disconnect (default: true) */
  autoReconnect?: boolean;
  /** Configure reconnect backoff; defaults used when omitted */
  reconnectConfig?: {
    backoff?: "fixed" | "exp";
    baseMs?: number;
    maxMs?: number;
    jitter?: number; // 0..1
  };
  /** If true, sanitize string data-channel messages by escaping HTML brackets */
  sanitizeDataChannelStrings?: boolean;
  /** Configuration for every peer connection; its iceServers are not replaced by the server's */
  peerConnectionConfig?: RTCConfiguration;
}

/** Options of {@link WebRTCClient.publish}. */
export interface PublishOptions {
  token?: string;
  /** Room (main track) to publish into as a subtrack; sent as `mainTrack` */
  roomId?: string;
  streamName?: string;
  metaData?: unknown;
  role?: string;
  subscriberId?: string;
  subscriberCode?: string;
  /** Publish a data channel only: no camera or microphone is used */
  dataOnly?: boolean;
}

/** Options of {@link WebRTCClient.play}. */
export interface PlayOptions {
  token?: string;
  /** Room to play; sent as `room` */
  roomId?: string;
  enableTracks?: string[];
  disableTracksByDefault?: boolean;
  subscriberId?: string;
  subscriberCode?: string;
  subscriberName?: string;
  /** Sent as `viewerInfo` */
  metaData?: unknown;
  role?: string;
  userPublishId?: string;
  /** Element that renders this stream (srcObject will be assigned) */
  remoteVideo?: HTMLVideoElement | null;
}

/**
 * Convenience structure of media devices grouped by kind.
 */
export interface GroupedDevices {
  videoInputs: Array<{ deviceId: string; label: string }>;
  audioInputs: Array<{ deviceId: string; label: string }>;
  audioOutputs: Array<{ deviceId: string; label: string }>;
  /** Currently selected input device ids, when available */
  selectedVideoInputId?: string;
  selectedAudioInputId?: string;
  selectedAudioOutputId?: string;
}

export interface RoomJoinOptions {
  roomId: string;
  streamId?: string;
  role?: string;
  metaData?: unknown;
  streamName?: string;
  mode?: "mcu" | "amcu" | "multitrack";
}
