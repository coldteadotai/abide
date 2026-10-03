import { Text } from "ink";
import { isAbideError, type AbideErrorCode } from "@coldtea/abide-schema";
import { Callout } from "../components/Callout.js";
import { palette } from "../theme.js";

/** Our own sentence for each failure; the machine's detail sits under it, dimmed. */
const TITLES: Record<AbideErrorCode, string> = {
  NO_API_KEY: "No API key, so nothing can be checked",
  KEY_FILE_UNWRITABLE: "The key was not saved",
  NO_INSTRUCTION_FILES: "No instruction files here, so there is nothing to compile",
  RUBRIC_INVALID: "The rubric could not be read",
  RUBRIC_MISSING: "No rubric yet",
  SETTINGS_INVALID: "The settings file could not be changed",
  GIT_UNAVAILABLE: "Git history is not readable here",
  CLAUDE_UNAVAILABLE: "Claude Code did not finish the turn",
  HEADLESS_UNAVAILABLE: "The headless agent could not run",
  HOST_UNKNOWN: "That is not an agent abide knows",
  HOST_NOT_FOUND: "No supported agent was found on this machine",
  CHECK_TIMEOUT: "Jev did not answer in time",
  CHECK_FAILED: "Jev refused the check",
  REPLAY_READ_FAILED: "The session file could not be read",
  REPLAY_RECORD_TOO_LARGE: "A session record is too large to read safely",
};

export function ErrorView({ error }: { error: unknown }) {
  const detail = error instanceof Error ? error.message : String(error);
  if (!isAbideError(error)) return <Callout tone="bad" title={detail} />;
  return (
    <Callout tone="bad" title={TITLES[error.code]}>
      <Text color={palette.mist} wrap="wrap">
        {detail}
      </Text>
      <Text color={palette.ash}>{error.code}</Text>
    </Callout>
  );
}
