import path from "node:path";
import { ReplayReadError } from "@coldtea/abide-schema";
import type { ReplaySession } from "./replay.js";

export type SkippedReplaySession = {
  file: string;
  code: ReplayReadError["code"];
  reason: string;
};

export type ReplayCollection = {
  sessions: ReplaySession[];
  skippedSessions: SkippedReplaySession[];
};

const mayBelongToRoot = (root: string, cwd: string | undefined): boolean => {
  if (cwd === undefined) return true;
  const relative = path.relative(root, cwd);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export const collectReplaySessions = async (
  root: string,
  files: readonly string[],
  parse: (file: string) => Promise<ReplaySession>,
): Promise<ReplayCollection> => {
  const sessions: ReplaySession[] = [];
  const skippedSessions: SkippedReplaySession[] = [];
  for (const file of files) {
    let session: ReplaySession;
    try {
      session = await parse(file);
    } catch (error) {
      if (!(error instanceof ReplayReadError)) throw error;
      if (!mayBelongToRoot(root, error.cwd)) continue;
      skippedSessions.push({ file, code: error.code, reason: error.message });
      continue;
    }
    if (mayBelongToRoot(root, session.cwd) && session.turns.length > 0) sessions.push(session);
  }
  return { sessions, skippedSessions };
};
