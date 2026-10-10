import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AbideError, assertNever } from "@coldtea/abide-schema";
import { packageRoot } from "./packageRoot.js";
import { readRegularText, writeRegularFile } from "./regularFile.js";

export const OPENCODE_PLUGIN_MARKER = "abide-opencode-plugin";

/**
 * The plugin as shipped in the package. The installed file only points at it,
 * so an upgrade needs no reinstall. OpenCode discovers `plugins/*.js` and
 * `*.ts` only, so the installed file is `.js` whatever the package uses.
 */
export const pluginSourcePath = (): string => path.join(packageRoot(), "opencode", "abide.mjs");

const shim = (source: string): string =>
  [
    `// ${OPENCODE_PLUGIN_MARKER}: written by \`abide init opencode\`; remove with \`abide uninstall opencode\`.`,
    `export { default } from ${JSON.stringify(pathToFileURL(source).href)};`,
    "",
  ].join("\n");

const installed = (target: string): "absent" | "owned" | "foreign" => {
  try {
    if (!lstatSync(target).isFile()) return "foreign";
    return readRegularText(target, { followSymlinks: false })?.startsWith(
      `// ${OPENCODE_PLUGIN_MARKER}:`,
    )
      ? "owned"
      : "foreign";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return "absent";
    return "foreign";
  }
};

export const installOpencodePlugin = (target: string): void => {
  const state = installed(target);
  const text = shim(pluginSourcePath());
  switch (state) {
    case "foreign":
      throw new AbideError(
        "SETTINGS_INVALID",
        `${target} already exists and is not an Abide plugin`,
      );
    case "absent":
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, text, { flag: "wx" });
      } catch (cause) {
        throw new AbideError(
          "SETTINGS_INVALID",
          `could not create the OpenCode plugin at ${target}`,
          {
            cause,
          },
        );
      }
      return;
    case "owned":
      if (!writeRegularFile(target, text, { use: "replace", followSymlinks: false }))
        throw new AbideError(
          "SETTINGS_INVALID",
          `could not write the OpenCode plugin at ${target}`,
        );
      return;
    default:
      return assertNever(state);
  }
};

export const uninstallOpencodePlugin = (target: string): boolean => {
  const state = installed(target);
  switch (state) {
    case "absent":
    case "foreign":
      return false;
    case "owned":
      rmSync(target);
      return true;
    default:
      return assertNever(state);
  }
};
