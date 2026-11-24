import type { ErrorCode } from "./errors.js";
import type { GroupedDevices } from "./types.js";
import type { PeerStats } from "./peer-stats.js";

/** One entry of a room's `streamList`. */
export interface RoomStreamEntry {
  streamId: string;
  streamName?: string;
  metaData?: string;
}

/** Payload of the `roomInformation` message. */
export interface RoomInformation {
  room: string;
  /** @deprecated server still sends it; prefer `streamList` */
  streams: string[];
  streamList: RoomStreamEntry[];
  /** Server sends this key literally, not the room name under a nicer key. */
  ATTR_ROOM_NAME?: string;
}

/** Payload of the `joinedTheRoom` notification. */
export interface RoomJoined extends RoomInformation {
  streamId: string;
  maxTrackCount?: number;
}

/** Payload of the `leavedFromRoom` notification. */
export interface RoomLeft {
  ATTR_ROOM_NAME?: string;
  streamId?: string;
}

/** Payload of the `broadcastObject` notification. */
export interface BroadcastObject {
  streamId: string;
  /** JSON-encoded Broadcast; caller parses it. */
  broadcast?: string;
}

export interface SubscriberCount {
  streamId: string;
  count: number;
}

export interface SubscriberList {
  streamId: string;
  /** Each entry is a JSON-encoded Subscriber. */
  subscriberList: string[];
}

export interface SubtrackList {
  streamId: string;
  /** Each entry is a JSON-encoded Broadcast. */
  subtrackList: string[];
}

export interface SubtrackCount {
  mainTrack: string;
  role?: string;
  status?: string;
  count: number;
}

export interface StreamInformationEntry {
  streamWidth: number;
  streamHeight: number;
  videoBitrate: number;
  audioBitrate: number;
  videoCodec: string;
}

/** Payload of the `streamInformation` message (one entry per ABR rendition). */
export interface StreamInformation {
  streamId: string;
  streamInfo: StreamInformationEntry[];
}

/** Payload of the `trackList` message. */
export interface TrackList {
  streamId: string;
  trackList: string[];
}

export interface VideoTrackAssignment {
  videoLabel: string;
  trackId: string;
  reserved: boolean;
}

/** Delivered over the data channel, not the websocket. */
export interface VideoTrackAssignmentList {
  streamId: string;
  payload: VideoTrackAssignment[];
}

/** Delivered over the data channel when the tracks of the played room change. */
export interface TrackListUpdated {
  streamId: string;
}

export interface NewTrackPayload {
  stream: MediaStream;
  track: MediaStreamTrack;
  streamId: string;
  /** Server-mapped track id when `idMapping` was supplied, else the raw track id. */
  trackId: string;
}

export interface TakeConfigurationPayload {
  streamId: string;
  sdp: string;
  type: RTCSdpType;
  idMapping?: Record<string, string>;
  streamTrackIds?: Record<string, string>;
}

export interface TakeCandidatePayload {
  streamId: string;
  label: number | null;
  id?: string;
  candidate: string;
}

export interface IceServerConfigPayload {
  stunServerUri?: string;
  turnServerUsername?: string;
  turnServerCredential?: string;
}

/** Raw `{command:"notification",definition:...}` frame, before it is mapped to a named event. */
export interface NotificationPayload {
  definition?: string;
  streamId?: string;
  [key: string]: unknown;
}

/**
 * Typed events emitted by the SDK clients.
 *
 * There is deliberately no `[key: string]: unknown` index signature: it made every typo a
 * valid event name and every payload `unknown`.
 */
export interface EventMap {
  initialized: void;
  closed: unknown;
  server_will_stop: unknown;
  publish_started: { streamId: string };
  publish_finished: { streamId: string };
  play_started: { streamId: string };
  play_finished: { streamId: string };
  ice_connection_state_changed: { state: RTCIceConnectionState; streamId: string };
  reconnection_attempt_for_publisher: { streamId: string };
  reconnection_attempt_for_player: { streamId: string };
  reconnected: { streamId: string };
  updated_stats: PeerStats;
  data_received: { streamId: string; data: string | ArrayBuffer };
  data_channel_opened: { streamId: string };
  data_channel_closed: { streamId: string };
  newTrackAvailable: NewTrackPayload;
  devices_updated: GroupedDevices;
  local_tracks_changed: void;
  local_track_paused: { kind: "audio" | "video" };
  local_track_resumed: { kind: "audio" | "video" };
  /** The browser ended a screen share (with or without the camera overlay); the camera is back. */
  screen_share_stopped: void;
  /** Server error frames arrive as `{ error: definition, message: frame, streamId }`. */
  error: { error: ErrorCode; message?: unknown; streamId?: string };

  // server notifications surfaced as first-class events
  room_information: RoomInformation;
  room_joined: RoomJoined;
  room_left: RoomLeft;
  broadcast_object: BroadcastObject;
  subscriber_count: SubscriberCount;
  subscriber_list: SubscriberList;
  stream_information: StreamInformation;
  track_list: TrackList;
  subtrack_list: SubtrackList;
  subtrack_count: SubtrackCount;
  video_track_assignments: VideoTrackAssignmentList;
  track_list_updated: TrackListUpdated;

  // dynamic notification channel, e.g. notification:subscriberCount
  [k: `notification:${string}`]: unknown;
}

/** Returned by `on()` and `once()`; removes that handler. */
export type Unsubscribe = () => void;
