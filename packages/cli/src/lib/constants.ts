/** Jev, called directly with a TypeSafe key, or through the Vercel AI Gateway with a gateway key. */
export const TYPESAFE_MODEL_ID = "jev-latest";
export const GATEWAY_MODEL_ID = "typesafe-ai/jev";
export const TYPESAFE_KEY_ENV = "TYPESAFE_AI_API_KEY";
export const GATEWAY_KEY_ENV = "AI_GATEWAY_API_KEY";

/** Point the direct TypeSafe call at a self-hosted, API-compatible endpoint instead of typesafe.ai. */
export const TYPESAFE_BASE_URL_ENV = "TYPESAFE_AI_BASE_URL";

/** List price observed 2026-09-17: $0.042 per million input tokens, output free. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const EDIT_CHECK_TIMEOUT_MS = 8_000;
export const TURN_CHECK_TIMEOUT_MS = 15_000;
export const STDIN_TIMEOUT_MS = 2_000;

/** Largest diff sent as state. Beyond this the diff is cut and marked. */
export const MAX_STATE_CHARS = 24_000;
export const MAX_TASK_CHARS = 600;

/** How many times one rule may block the same file within one turn before it only flags. */
export const MAX_BLOCKS_PER_RULE_PER_TURN = 2;
/** How many Stop checks one turn gets: the first, plus one re-check after a repair. */
export const MAX_STOP_CHECKS_PER_TURN = 2;

export const SESSION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long another session's turn counts as open. An interrupted turn never reaches Stop. */
export const OPEN_TURN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** How long a single git call may run before it is killed. Well under every hook budget. */
export const GIT_TIMEOUT_MS = 5_000;
/** How long turn-start may spend snapshotting the working tree with git, all calls together. */
export const TURN_START_TIMEOUT_MS = 5_000;
/** How long Stop may spend on its own snapshot and the diff against the baseline. */
export const STOP_GIT_TIMEOUT_MS = 8_000;

/** How long computing one diff may take. Past this the check is skipped and logged rather than the hook held. */
export const DIFF_TIMEOUT_MS = 2_000;
/** Largest before-plus-after text a diff is attempted on at all. */
export const MAX_DIFF_INPUT_CHARS = 1_000_000;
/** Past this a file counts as unreadable. */
export const MAX_FILE_READ_BYTES = 16 * 1024 * 1024;
export const MAX_REPLAY_RECORD_BYTES = 16 * 1024 * 1024;
/** How long Stop's per-file fallback may spend on all of its diffs together. */
export const STOP_FALLBACK_DIFF_TIMEOUT_MS = 6_000;
