import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

const runnable = (file: string, windows: boolean): boolean => {
  try {
    const isFile = statSync(file).isFile();
    if (isFile && !windows) accessSync(file, constants.X_OK);
    return isFile;
  } catch {
    return false;
  }
};

/**
 * What `which` would answer, without a shell: the first PATH entry holding
 * the executable. Windows shells find a command by trying each PATHEXT
 * suffix, and npm installs an agent's launcher there as `claude.cmd`.
 */
export const findExecutable = (
  bin: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const windows = platform === "win32";
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "");
  const suffixes = windows ? (process.env.PATHEXT ?? DEFAULT_PATHEXT).toLowerCase().split(";") : [];
  const names = [bin, ...suffixes.filter((ext) => ext !== "").map((ext) => bin + ext)];
  for (const dir of dirs) {
    const found = names.map((name) => path.join(dir, name)).find((file) => runnable(file, windows));
    if (found !== undefined) return found;
  }
  return undefined;
};
