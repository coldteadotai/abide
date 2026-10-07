import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests sandbox the home directory; a developer's own Claude config dir must not leak in.
  test: { env: { CLAUDE_CONFIG_DIR: "" }, unstubEnvs: true },
});
