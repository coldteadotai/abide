import { execFileSync } from "node:child_process";

/** Windows has no FIFOs on the file system, so the cases that plant one skip there. */
export const NO_FIFO = process.platform === "win32";

export const mkfifo = (file: string): void => {
  execFileSync("mkfifo", [file]);
};
