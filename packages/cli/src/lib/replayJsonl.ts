import { z } from "zod";
import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { finished } from "node:stream/promises";
import { ReplayReadError } from "@coldtea/abide-schema";
import { openRegular } from "./regularFile.js";
import { MAX_REPLAY_RECORD_BYTES } from "./constants.js";

const chunkSchema = z.instanceof(Buffer);

const readChunk = async (chunks: AsyncIterator<unknown>): Promise<IteratorResult<unknown>> => {
  try {
    return await chunks.next();
  } catch (cause) {
    throw new ReplayReadError("REPLAY_READ_FAILED", "could not read session file", { cause });
  }
};

export async function* readSessionLines(
  file: string,
  cwd: () => string | undefined,
): AsyncGenerator<string> {
  try {
    yield* readReplayLines(file);
  } catch (error) {
    if (!(error instanceof ReplayReadError)) throw error;
    throw new ReplayReadError(error.code, error.message, { cwd: cwd(), cause: error });
  }
}

export async function* readReplayLines(
  file: string,
  maxRecordBytes = MAX_REPLAY_RECORD_BYTES,
): AsyncGenerator<string> {
  const opened = openRegular(file);
  if (opened === undefined)
    throw new ReplayReadError("REPLAY_READ_FAILED", "could not read a regular session file");
  const stream = createReadStream(file, { fd: opened.fd, autoClose: true });
  // The iterator reports read errors; stopping early can also close the stream before EOF.
  const closed = finished(stream, { cleanup: true }).catch(() => {});
  const chunks: AsyncIterator<unknown> = stream[Symbol.asyncIterator]();
  let parts: Buffer[] = [];
  let bytes = 0;
  const append = (part: Buffer): void => {
    if (bytes + part.length > maxRecordBytes)
      throw new ReplayReadError(
        "REPLAY_RECORD_TOO_LARGE",
        `session record exceeds ${maxRecordBytes} bytes`,
      );
    if (part.length > 0) parts.push(part);
    bytes += part.length;
  };
  const takeLine = (): string => {
    const line = Buffer.concat(parts, bytes).toString("utf8");
    parts = [];
    bytes = 0;
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  };
  try {
    for (let next = await readChunk(chunks); !next.done; next = await readChunk(chunks)) {
      const chunk = chunkSchema.parse(next.value);
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        append(chunk.subarray(start, end));
        yield takeLine();
        start = end + 1;
      }
      append(chunk.subarray(start));
    }
    if (bytes > 0) yield takeLine();
  } finally {
    stream.destroy();
    await closed;
  }
}
