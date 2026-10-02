import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AbideError, assertNever } from "@coldtea/abide-schema";
import { packageRoot } from "./packageRoot.js";
import { readRegularText, writeRegularFile } from "./regularFile.js";

export const PI_EXTENSION_MARKER = "// abide-pi-extension:";
export const piExtensionPath = (): string => path.join(packageRoot(), "dist", "pi", "extension.js");

const installed = (target: string): "absent" | "owned" | "foreign" => {
  try {
    if (!lstatSync(target).isFile()) return "foreign";
    return readRegularText(target, { followSymlinks: false })?.startsWith(PI_EXTENSION_MARKER)
      ? "owned"
      : "foreign";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return "absent";
    return "foreign";
  }
};

export const installPiExtension = (target: string): void => {
  const source = piExtensionPath();
  if (!existsSync(source))
    throw new AbideError(
      "SETTINGS_INVALID",
      "the Pi extension is missing; build Abide before installing",
    );
  const state = installed(target);
  const text = `${PI_EXTENSION_MARKER} written by abide init pi; remove with abide uninstall pi\nexport { default } from ${JSON.stringify(pathToFileURL(source).href)};\n`;
  switch (state) {
    case "foreign":
      throw new AbideError(
        "SETTINGS_INVALID",
        `${target} already exists and is not an Abide extension`,
      );
    case "absent":
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, text, { flag: "wx" });
      } catch (cause) {
        throw new AbideError("SETTINGS_INVALID", `could not create the Pi extension at ${target}`, {
          cause,
        });
      }
      return;
    case "owned":
      if (!writeRegularFile(target, text, { use: "replace", followSymlinks: false }))
        throw new AbideError("SETTINGS_INVALID", `could not write the Pi extension at ${target}`);
      return;
    default:
      return assertNever(state);
  }
};

export const uninstallPiExtension = (target: string): boolean => {
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
