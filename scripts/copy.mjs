import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const [source, destination] = process.argv.slice(2);
if (source === undefined || destination === undefined) {
  console.error("usage: node copy.mjs <source> <destination>");
  process.exit(1);
}

mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(source, destination);
