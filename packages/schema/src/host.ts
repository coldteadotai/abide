import { z } from "zod";

/** The coding agents abide can hook into. Adding one here fails every consumer that has not handled it. */
export const hostSchema = z.enum(["claude", "codex", "opencode", "pi"]);
export type Host = z.infer<typeof hostSchema>;
export const HOSTS: readonly Host[] = hostSchema.options;
