export const BINARY_SAMPLE_BYTES = 8_000;

// Git's content heuristic; inspect bytes before a UTF-8 decode can replace them.
export const isBinaryContent = (content: Buffer): boolean =>
  content.subarray(0, BINARY_SAMPLE_BYTES).includes(0);
