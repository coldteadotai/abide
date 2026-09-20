<p align="center">
  <img src="docs/images/abide.png" width="220" alt="Abide, the officer who reads every edit">
</p>

<h1 align="center">Abide</h1>

<p align="center">
  <em>Coding agents break your rules from the very first edit. Abide catches every one and makes your agent fix it</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenCode-111111?style=flat-square" alt="Works with Claude Code, Codex and OpenCode">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center">
  <strong>1 in 13 turns break a rule no linter can catch &middot; abide does  &middot; 300 ms per check &middot; a tenth of a cent per turn</strong><br>
  <sub>Measured by replaying 93 real Claude Code sessions (1,256 edits, 147 turns) in two repos against their own AGENTS.md, for 22 cents. Jev flagged 39 edits and 15 turns; an independent reviewer confirmed 10 and 11. The turn-level catches (single-use abstractions, oversized files, duplicated logic) held up 11 times in 15. Method, per-rule table and what was wrong: <a href="benchmarks/replay/README.md">benchmarks/replay</a>.</sub>
</p>

---

```
npx @coldtea/abide login    # pick a key type, paste it once
npx @coldtea/abide init     # hooks into every agent on this machine
```

Then start `claude`, `codex` or `opencode` as usual. That is the whole setup.

## What it does

Your AGENTS.md, CLAUDE.md and the rest of your project instructions are full of rules no linter can check. "Never let a raw error reach a user." "Don't create premature abstractions." Nothing can script those, so nothing enforces them. In 93 real sessions, the agent broke one on 1 turn in 13, from the first edit on.

https://github.com/user-attachments/assets/2d45f6b0-c889-474c-ab4a-8d019fdc7140

Abide enforces exactly those rules. On every edit (or turn) it asks [Jev](https://typesafe.ai), TypeSafe's decision model, one question per rule and gets a probability back. Jev sees the compiled rule questions, file path(s), diff and, when available, up to 600 characters of the current user prompt. It does not receive the full conversation history, so edit 200 is checked like edit 1. Break a rule and the agent is told which one and fixes it in the same turn.

![A rule caught and repaired inside a coding session](docs/images/block.svg)

- One call per edit, about 300 ms, a few thousandths of a cent.
- Rules a linter could check are handed to your linter instead.
- No built-in rules. No instruction files, nothing to enforce.
- Your key, your data. Nothing here talks to a server of ours.

## Not previously possible

Checking every edit or turn against every rule was never worth doing (economically and latency-wise) with an ordinary LLM. A check is about 2,500 tokens. At typical model prices that is a cent or more, and a few seconds, per edit, and the answer comes back as prose you then have to parse and cannot fully trust. Two hundred edits a day made it a non-starter.

Jev changes the arithmetic. It is a decision model, so it answers a typed question with a calibrated probability and nothing else. There is no free text, so there is nothing to make up. It is up to 100x cheaper than a typical LLM and answers in about 300 ms. That is what makes it reasonable to check every edit, every time.

## Three minutes to the first catch

1. Get a TypeSafe API key at [typesafe.ai](https://typesafe.ai), or use a Vercel AI Gateway key you already have.
2. Run `npx @coldtea/abide login`, pick which kind of key it is and where it lives, and paste it. It goes to `~/.abide/.env` for every repo on the machine, or to `.env.local` in this repo, owner-only either way. A `.env` you already have at the repo root works too.
3. Run `npx @coldtea/abide init` in your repo.
4. Start your agent. Its first turn compiles your rules into `.abide/rubric.json` and tells you what it found.
5. Ask for something your rules forbid. An AGENTS.md that says "use Yup, never validate by hand" produces this the moment the agent writes a manual guard:

```
Abide: This edit appears to break a rule from this repository's instructions.
- Rule "api-validation-uses-yup" from ~/.codex/AGENTS.md line 65: "When writing API endpoints, do NOT write input validations manually. Use Yup (with clear validation messages) + early return in the API handler". (0.86)
Repair apps/web/src/pages/api/logout.ts now, then continue with the task.
```

The agent repairs it before moving on. No human in the loop.

![abide check on a violating diff](docs/images/check.svg)

## Agents

| Agent       | Install                            | Where it lands                        |
| ----------- | ---------------------------------- | ------------------------------------- |
| Claude Code | `npx @coldtea/abide init claude`   | `~/.claude/settings.json`             |
| Codex       | `npx @coldtea/abide init codex`    | `~/.codex/hooks.json`                 |
| OpenCode    | `npx @coldtea/abide init opencode` | `~/.config/opencode/plugins/abide.js` |

`init` with no name installs into every agent it finds. Add `--project` to install into the repo instead, so teammates get it with the checkout.

Codex only: start `codex`, type `/hooks`, and accept the four abide entries. Codex asks this once for any new hook. Codex edits through `apply_patch`; abide reads the patch and judges every file in it.

OpenCode only: there are no hook processes, so abide runs as a plugin. Same checks, same messages: an edit that breaks a rule gets the repair request appended to its tool result, and a turn that ends with one gets a single follow-up message.

## See what your codebase already breaks

```
abide audit src/
```

Every file is judged as if it had just been written. You get a table by rule and a list by file. On 33 API routes of a real Next.js app: 12 seconds, about a cent.

![abide audit on 33 API routes](docs/images/audit.svg)

## Commands

| Command                   | What it does                                                          |
| ------------------------- | --------------------------------------------------------------------- |
| `abide login`             | store your TypeSafe or Vercel AI Gateway key, for you or this repo    |
| `abide init [agent]`      | install the hooks (`claude`, `codex`, `opencode`, or every one found) |
| `abide audit [paths]`     | judge existing files, report by rule and by file                      |
| `abide check [paths]`     | check uncommitted changes the way the hooks would                     |
| `abide report`            | your rules, what fired, what never fires                              |
| `abide replay <agent>`    | judge this repo's past sessions in any of the three agents            |
| `abide compile`           | compile the rubric now instead of at the next session                 |
| `abide calibrate`         | score every rule against your recent git history                      |
| `abide tune`              | rewrite the rules that never fire                                     |
| `abide bench`             | latency and spend, measured on your machine                           |
| `abide uninstall [agent]` | remove the hooks                                                      |

`report`, `check`, `audit`, `bench` and `calibrate` take `--json`.

## The rubric is yours

`.abide/rubric.json` is a committed, readable file. Every verdict names a rule in it, and every rule quotes the line of your instruction file it came from. A wrong verdict is a rule you can rewrite.

- Each rule runs at one of two moments: `edit` after each edit, `turn` once at the end against the whole diff. "Did this add more than was asked" has no answer after edit 1 of 12.
- Each rule can carry a `scope` of globs, so an API route and a stylesheet get different questions.
- Verdicts are banded. 0.8 and above: the agent is told to repair. 0.5 to 0.8: you see a note, the agent does not. Below 0.5: nothing.
- A badly worded rule scores 0.4 on everything and never fires. `calibrate` finds those against twenty real hunks from your history and switches them off. `tune` has the agent rewrite them.

![abide report](docs/images/report.svg)

## Cost, privacy, safety

- Compiled rule questions, file path(s), changed lines and, when available, up to 600 characters of the current user prompt go to TypeSafe under your key. The full conversation history is not sent. Zero data retention is requested when routing through Vercel AI Gateway; the direct TypeSafe path does not send that gateway-specific option. Nothing is sent to a Coldtea server.
- Key lookup order: the environment, then `.env.local` and `.env` at the repo root, then `~/.abide/.env`. Never a flag, never logged. Set `AI_GATEWAY_API_KEY` instead of a TypeSafe key to go through your Vercel AI Gateway.
- A check on this repo's 13 rules is 1,000 to 1,600 input tokens: $0.00004 to $0.00007, about 300 ms for Jev and about 1 s for the whole hook including Node startup. A turn of 15 edits costs a tenth of a cent. Measured 2026-09-18, direct to TypeSafe. `abide bench` measures yours.
- The hooks cannot break your session. Every path exits 0, has a hard deadline, and prints only what the host expects.
- No key or no network: the edit goes through unchecked and the miss is logged in `.abide/events.jsonl`, where `report` counts it.

## How it hooks in

Four hooks per agent. Session start: hash the instruction files, ask the agent to compile if they changed. Turn start: snapshot the working tree with git. After each edit: run the edit-phase rules on that hunk. End of turn: diff the whole turn against the snapshot and run the turn-phase rules, plus the edit-phase rules for anything a shell command wrote.

## Uninstall

```
abide uninstall            # every agent it was installed into
abide uninstall codex      # one agent; add --project for a project-level install
```

Removes abide's own entries and nothing else. Rubric files and `~/.abide/.env` stay until you delete them.

## Layout

- `packages/schema`: the rubric, hook payloads, verdicts and events as zod schemas.
- `packages/cli`: the `abide` command, the hook script and the OpenCode plugin.
- `skills/abide-compile`: the procedure the agent follows to compile a rubric.

## License

[MIT](LICENSE)
