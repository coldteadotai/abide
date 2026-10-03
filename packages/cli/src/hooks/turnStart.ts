import path from "node:path";
import { turnIdOf, turnStartInputSchema, type HookOutput } from "@coldtea/abide-schema";
import { TURN_START_TIMEOUT_MS } from "../lib/constants.js";
import { headCommit, isGitRepo, snapshotTree } from "../lib/git.js";
import { findRepoRoot } from "../lib/paths.js";
import {
  clearTurn,
  markBaseline,
  markShared,
  openTurnsIn,
  turnDir,
  writeBaseline,
  writePrompt,
  writeTurnHead,
  writeTurnRoot,
} from "../lib/session.js";

/**
 * The turn is about to begin: remember what the working tree looks like now,
 * so the Stop check can diff the whole turn, whichever tool made the changes.
 * Prints nothing: on this event plain stdout would become context.
 */
export const handleTurnStart = async (raw: unknown): Promise<HookOutput> => {
  const parsed = turnStartInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const root = findRepoRoot(input.cwd);
  const turnId = turnIdOf(input);
  const dir = turnDir(input.session_id, turnId);
  // Without a turn id every turn shares one directory, so the last turn's
  // records go before this one's start.
  if (turnId === undefined) clearTurn(dir);
  if (input.prompt !== undefined) writePrompt(dir, input.prompt);
  if (!isGitRepo(root)) return { kind: "silent" };
  // Written before the attempt: a hook that dies mid-snapshot leaves "pending"
  // behind, and the Stop check reads that as a turn it cannot see whole.
  markBaseline(dir, "pending");
  // Before the search, so of two turns starting at once, the later one finds the other.
  writeTurnRoot(dir, root);
  const open = openTurnsIn(root, input.session_id);
  for (const other of open) markShared(other);
  if (open.length > 0) markShared(dir);
  const startedAt = Math.floor(Date.now() / 1000);
  const deadline = performance.now() + TURN_START_TIMEOUT_MS;
  const head = headCommit(root, TURN_START_TIMEOUT_MS);
  const tree = snapshotTree(
    root,
    path.join(dir, "index"),
    Math.floor(deadline - performance.now()),
  );
  if (tree === undefined) {
    markBaseline(dir, "failed");
    return { kind: "silent" };
  }
  writeBaseline(dir, tree);
  if (head !== undefined) writeTurnHead(dir, { commit: head, startedAt });
  markBaseline(dir, "ok");
  return { kind: "silent" };
};
