# Pi extension

Tested with Pi 0.99.1. Abide runs its checker and capture worker through `node` on PATH, independently of Pi's executable. Native-binary Pi builds have not yet been exercised end-to-end.

## Install

```sh
abide login
abide init pi
pi
```

`init` without an agent name includes Pi when it is detected. User-level installation writes a marked shim to `~/.pi/agent/extensions/abide.js`, or the directory selected by `PI_CODING_AGENT_DIR`. It changes no Pi settings. Restart Pi or run `/reload` to load the extension.

For a project-level installation:

```sh
abide init pi --project
pi --approve
```

This writes `.pi/extensions/abide.js`. Pi must trust the project before loading it. Repeated installation refreshes Abide's shim; it refuses to overwrite an unrelated file or a symlink. Remove an old unmarked manual shim before migrating to `init`.

```sh
abide uninstall pi
abide uninstall pi --project
```

Uninstall removes only the marked shim. Rubrics, event logs, and credentials remain. Re-run `init` after installing a new Abide version if its package location changed.

When developing from this checkout, run `pnpm install` and `pnpm build`, then run `node /absolute/path/to/abide/packages/cli/dist/bin.js init pi` from the target project. Direct loading remains available through `pi --extension /absolute/path/to/abide/packages/cli/dist/pi/extension.js`.

The extension uses Abide's existing key lookup and rubric. Instruction discovery includes Pi's `~/.pi/agent` directory, or `PI_CODING_AGENT_DIR` when set. Pi's global context selection gives `AGENTS.override.md` precedence. Shared project discovery keeps other hosts' instruction files, including `CLAUDE.md`, alongside overrides.

## Events and checks

Pi loads an extension factory that registers `pi.on()` handlers. The adapter invokes Abide's existing hook subprocesses; it does not install command hooks into Pi's settings.

| Pi event              | Adapter action                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `session_start`       | Check instruction freshness and prepare compilation context                                 |
| `before_agent_start`  | Snapshot the activity and deliver pending compilation context                               |
| `message_end`         | Update task context from actual user messages, including queued and steered requests        |
| `tool_call`           | Capture bounded pre-edit state without blocking the tool                                    |
| `tool_result`         | Check successful local edits and append named-rule repair feedback                          |
| `agent_before_settle` | Check the complete diff, including shell changes, and request a bounded repair continuation |
| `agent_settled`       | Clear persisted turn state and transient activity state                                     |
| `session_shutdown`    | Cancel outstanding checks and release persisted and transient state                         |

One snapshot covers the activity from `before_agent_start` through final settlement, including continuations requested by other extensions. Pre-settlement checks retain it; `agent_settled` releases it. Pi's model-turn events do not reset it. The adapter allows at most one final repair continuation. Queued or steered prompts update its bounded task context without replacing that snapshot. Clean checks requested by other extensions do not consume Abide's repair allowance.

Advisories appear as UI notifications, or as non-context session entries in headless modes. Missing credentials, failed checks, and timeouts leave Pi usable. Code changes still go to TypeSafe or the configured gateway under your key. Checks run after mutations; this adapter is not a pre-write security boundary.

Immediate checks skip unreadable files, symlink paths, oversized files, and overlapping mutations whose exact before/after state is uncertain. The final diff covers those changes when git can snapshot the working tree. Without git, shell-only changes cannot be checked through the per-file fallback.

## Replay and shared commands

`abide check`, `audit`, `report`, `bench`, and `calibrate` use the same checker and rubric for Pi as for other hosts. A stale rubric is compiled by Pi in its next activity; Claude is not required for that session-start path. The existing standalone `abide compile` and `tune` commands still use Claude, as they do for the other hosts.

```sh
abide replay pi
abide replay pi /path/to/session.jsonl --json
```

Replay discovers sessions under the Pi agent directory, or `PI_CODING_AGENT_SESSION_DIR` when set. Use an explicit path for a custom session location. It reads the latest persisted branch, matches successful tool results to their calls, and reuses Pi's recorded edit patch when available. Like other transcript replay adapters, it cannot reconstruct shell-only changes or nested calls whose arguments were not recorded. A write without original file contents is judged from its recorded full content.

## Live verification

The normal test suite skips the live repair test. To run it after building:

```sh
ABIDE_PI_LIVE=1 pnpm --filter @coldtea/abide exec vitest run test/piLifecycle.live.test.ts
```

This uses your configured Pi model and Abide credentials, so it makes paid API calls. It runs in a temporary clone with this repository's existing rubric. The test installs with `abide init pi --project`, then loads that installed shim. Pi writes a deliberate single-use helper, receives a steered requirement, and must inline the helper during one live Jev repair continuation. The test checks that both verdicts keep the same task identity and that the repaired change clears the final check. It does not change this checkout's files or rubric.
