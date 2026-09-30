# Local Pi extension

Tested with Node-backed Pi 0.99.1. Native-binary Pi builds are outside the verified scope: the subprocess bridge assumes the host executable can run Node scripts.

Build Abide before loading the extension. Pi can load TypeScript extensions directly, but this adapter needs Abide's compiled hook script and capture worker:

```sh
pnpm install
pnpm build
pi --no-extensions --extension ./packages/cli/dist/pi/extension.js
```

This command loads only the Abide extension. Omit `--no-extensions` to keep your other Pi extensions enabled.

For project-local discovery, create `.pi/extensions/abide.js` with:

```js
export { default } from "../../packages/cli/dist/pi/extension.js";
```

After you trust the project, a normal `pi` launch discovers this entry point. Use `pi --approve` for a one-off trusted run. Installation through `abide init` and package distribution are not part of this change.

The extension uses Abide's existing key lookup and rubric. Instruction discovery includes Pi's `~/.pi/agent` directory, or `PI_CODING_AGENT_DIR` when set. An `AGENTS.override.md` takes precedence over the other context files in its directory.

## Events and checks

Pi loads an extension factory that registers `pi.on()` handlers. The adapter invokes Abide's existing hook subprocesses; it does not install command hooks into Pi's settings.

| Pi event              | Adapter action                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `session_start`       | Check instruction freshness and prepare compilation context                                 |
| `before_agent_start`  | Snapshot the activity and deliver pending compilation context                               |
| `tool_call`           | Capture bounded pre-edit state without blocking the tool                                    |
| `tool_result`         | Check successful local edits and append named-rule repair feedback                          |
| `agent_before_settle` | Check the complete diff, including shell changes, and request a bounded repair continuation |
| `agent_settled`       | Clear transient activity state                                                              |
| `session_shutdown`    | Cancel outstanding checks and release state                                                 |

One snapshot covers the activity from `before_agent_start` through final settlement, including a repair continuation. Pi's model-turn events do not reset it. The adapter allows at most one final repair continuation. Queued or steered prompts share the activity; Abide's task context currently comes from its initial prompt.

Advisories appear as UI notifications, or as non-context session entries in headless modes. Missing credentials, failed checks, and timeouts leave Pi usable. Code changes still go to TypeSafe or the configured gateway under your key. Checks run after mutations; this adapter is not a pre-write security boundary.

Immediate checks skip unreadable files, symlink paths, oversized files, and overlapping mutations whose exact before/after state is uncertain. The final diff covers those changes when git can snapshot the working tree. Without git, shell-only changes cannot be checked through the per-file fallback.

## Live verification

The normal test suite skips the live repair test. To run it after building:

```sh
ABIDE_PI_LIVE=1 pnpm --filter @coldtea/abide exec vitest run test/piLifecycle.live.test.ts
```

This uses your configured Pi model and Abide credentials, so it makes paid API calls. It runs in a temporary clone with this repository's existing rubric. Pi writes a deliberate single-use helper, Jev flags it at settlement, and Pi must inline it during one repair continuation. The test checks that both verdicts keep the same task identity and that the repaired change clears the final check. It does not change this checkout's files or rubric.
