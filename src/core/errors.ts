/**
 * Error codes the SDK reports itself. Server error frames pass their `definition` through as the
 * code (e.g. `no_stream_exist`, `unauthorized_access`), hence any string is accepted.
 */
export type ErrorCode =
  | "WebSocketNotConnected"
  | "getUserMediaIsNotAllowed"
  | "NotAllowedError"
  | "NotFoundError"
  | "NotReadableError"
  | "OverconstrainedError"
  | "notSetRemoteDescription"
  | "notSetLocalDescription"
  | "no_local_stream"
  | "streamIdInUse"
  | "stream_stopped"
  | "timeout"
  | "data_channel_error"
  | "data_channel_blob_parse_failed"
  | "data_channel_not_available"
  | "set_sink_id_failed"
  | "set_sink_id_unsupported"
  | "session_ended"
  | "session_not_live"
  | (string & {});

/**
 * Standardized error type produced by the SDK. Use {@link code} for programmatic handling.
 */
export class SDKError extends Error {
  readonly code: ErrorCode;
  readonly info?: unknown;

  constructor(code: ErrorCode, message?: string, info?: unknown) {
    super(message ?? code);
    this.name = "SDKError";
    this.code = code;
    this.info = info;
  }
}
