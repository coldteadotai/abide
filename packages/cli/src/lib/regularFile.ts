import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { MAX_FILE_READ_BYTES } from "./constants.js";

type Use = "read" | "append" | "replace";

type OpenOptions = {
  followSymlinks?: boolean;
  use?: Use;
};

type ReadOptions = Omit<OpenOptions, "use"> & { maxBytes?: number; prefixBytes?: number };

type WriteOptions = Omit<OpenOptions, "use"> & { use: Exclude<Use, "read"> };

const FLAGS: Record<Use, number> = {
  read: constants.O_RDONLY,
  append: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
  replace: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
};

/**
 * A FIFO or device would hold a synchronous read or write for as long as the
 * other side likes, past any hook deadline. Opening non-blocking and judging
 * the descriptor leaves no window between the check and the use. The caller
 * closes it.
 */
export const openRegular = (
  file: string,
  options: OpenOptions = {},
): { fd: number; size: number } | undefined => {
  const { followSymlinks = true, use = "read" } = options;
  let fd: number;
  try {
    fd = openSync(
      file,
      FLAGS[use] | constants.O_NONBLOCK | (followSymlinks ? 0 : constants.O_NOFOLLOW),
    );
  } catch {
    return undefined;
  }
  let stat: Stats | undefined;
  try {
    stat = fstatSync(fd);
  } catch {
    stat = undefined;
  }
  if (stat?.isFile()) return { fd, size: stat.size };
  closeSync(fd);
  return undefined;
};

export const readRegularFile = (file: string, options: ReadOptions = {}): Buffer | undefined => {
  const { maxBytes = MAX_FILE_READ_BYTES, prefixBytes, ...open } = options;
  const opened = openRegular(file, open);
  if (opened === undefined) return undefined;
  const { fd, size } = opened;
  try {
    if (size > maxBytes) return undefined;
    const length = prefixBytes === undefined ? size : Math.min(size, prefixBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, read);
      if (count === 0) break;
      read += count;
    }
    return buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
};

export const readRegularText = (file: string, options: ReadOptions = {}): string | undefined =>
  readRegularFile(file, options)?.toString("utf8");

/** writeFileSync on the fd loops; a lone writeSync can stop short on a full disk without throwing. */
export const writeRegularFile = (file: string, text: string, options: WriteOptions): boolean => {
  const opened = openRegular(file, options);
  if (opened === undefined) return false;
  try {
    writeFileSync(opened.fd, text);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(opened.fd);
  }
};
