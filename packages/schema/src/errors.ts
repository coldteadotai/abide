export type AbideErrorCode =
  | "NO_API_KEY"
  | "KEY_FILE_UNWRITABLE"
  | "NO_INSTRUCTION_FILES"
  | "RUBRIC_INVALID"
  | "RUBRIC_MISSING"
  | "SETTINGS_INVALID"
  | "HOST_UNKNOWN"
  | "HOST_NOT_FOUND"
  | "GIT_UNAVAILABLE"
  | "CLAUDE_UNAVAILABLE"
  | "HEADLESS_UNAVAILABLE"
  | "CHECK_TIMEOUT"
  | "REPLAY_READ_FAILED"
  | "REPLAY_RECORD_TOO_LARGE"
  | "CHECK_FAILED";

export class AbideError extends Error {
  readonly code: AbideErrorCode;

  constructor(code: AbideErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AbideError";
    this.code = code;
  }
}

export const isAbideError = (value: unknown): value is AbideError => value instanceof AbideError;

export class ReplayReadError extends AbideError {
  override readonly code: "REPLAY_READ_FAILED" | "REPLAY_RECORD_TOO_LARGE";
  readonly cwd: string | undefined;

  constructor(
    code: ReplayReadError["code"],
    message: string,
    options?: { cause?: unknown; cwd?: string },
  ) {
    super(code, message, options);
    this.code = code;
    this.cwd = options?.cwd;
  }
}
