import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const windowsSymlinksAvailable = (): boolean => {
  const root = mkdtempSync(path.join(tmpdir(), "abide-symlink-check-"));
  const target = path.join(root, "target");
  try {
    writeFileSync(target, "target");
    symlinkSync(target, path.join(root, "link"));
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = error.code;
      if (typeof code === "string" && ["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code))
        return false;
    }
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** Windows may require Developer Mode or elevation to create symbolic links. */
export const NO_SYMLINK = process.platform === "win32" && !windowsSymlinksAvailable();
