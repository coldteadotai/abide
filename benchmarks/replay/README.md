# Replay: what abide would have caught in 93 real sessions

Date: 2026-09-18. Judge: Jev (`jev-latest`), called directly with a TypeSafe key.

NB: I ran this on my [private project](https://www.coldtea.ai), and one public one (https://github.com/coldteadotai/pr-lens). But the method can be reproduced as below.

## Method

`abide replay` reads Claude Code transcripts from `~/.claude/projects/<repo>/`, rebuilds every Edit and Write as the hook payload the edit hook would have received, and judges it with the repo's compiled rubric. Then it groups the edits by turn and judges each turn with the turn rules, the way the stop hook does. Nothing is re-run; the diffs come from the transcripts. Edits outside the repo root (scratch files, plans, worktree copies) are skipped. Changes made through shell commands are not in a transcript and are not judged.

Two private repos, each with its own AGENTS.md, rubrics compiled by `abide compile` and calibrated against each repo's git history. One question was hand-tightened after a first pass: the "narrating comment" rule had been compiled to fire on any comment a reader could reconstruct from the code, which flagged every explanatory doc block; it now asks for a comment that restates the adjacent code with no reason, constraint or gotcha, which is what the rule text says.

Every flagged edit and turn was then read by an independent reviewer (Claude, reading each rule's own text strictly) and marked confirmed or not. The repo owner spot-checked four comment-rule flags in the first pass and agreed with all four, so the strict reading here is the conservative end.

## Results

|                       | pr-lens-app |   coldtea |      both |
| --------------------- | ----------: | --------: | --------: |
| Sessions with edits   |          38 |        55 |        93 |
| Edits judged          |         687 |       569 |     1,256 |
| Edits flagged at 0.8+ |   17 (2.5%) | 22 (3.9%) | 39 (3.1%) |
| Turns judged          |          73 |        74 |       147 |
| Turns flagged at 0.8+ |           8 |         7 |  15 (10%) |
| Jev cost              |       $0.13 |     $0.09 |     $0.22 |
| Wall time             |        68 s |      57 s |     2 min |

After independent review:

|       | Flagged | Confirmed | Precision |
| ----- | ------: | --------: | --------: |
| Edits |      39 |        10 |       26% |
| Turns |      15 |        11 |       73% |
| All   |      54 |        21 |       39% |

So across 1,256 edits and 147 turns: 8 confirmed violations per 1,000 edits, and 1 turn in 13 ends with a confirmed violation of a rule no linter could express. 11 of the 93 sessions contained at least one.

Recall, from the 20 cleared hunks that came closest to the line (0.31 to 0.48): one real miss, a props-ordering violation. The rest were correctly cleared.

## By rule, confirmed over flagged

| Rule                             | Phase | Flagged | Confirmed |
| -------------------------------- | ----- | ------: | --------: |
| single-use-abstraction           | turn  |       8 |         6 |
| file-length-500                  | turn  |       3 |         3 |
| rust-bare-string-user-error      | edit  |       3 |         3 |
| adjacent-improvements            | edit  |       3 |         2 |
| comment-volume                   | edit  |      10 |         2 |
| plain-error-for-expected-failure | edit  |      11 |         1 |
| unparsed-inbound-payload         | edit  |       4 |         1 |
| react-props-ordered-by-length    | edit  |       2 |         1 |
| unrelated-refactor               | turn  |       2 |         1 |
| no-duplicated-logic              | turn  |       1 |         1 |
| reinvent-mantine                 | edit  |       1 |         1 |
| six other rules                  | edit  |       8 |         0 |

## What the false positives are

Two rules produce most of them, and both are fixable in the rubric rather than in the model:

- `plain-error-for-expected-failure` fires on `throw new Error(...)` in scripts, tests and invariant checks, where no caller handles the failure. The rule needs a `scope` of `src/**` and a criteria example for an invariant throw.
- `comment-volume` fires on explanatory doc blocks in a codebase whose owner writes long ones on purpose. Whether those break the rule is the owner's call; the strict reading says no.

Both are what `abide calibrate` and `abide tune` exist for, and the numbers above are before either was run on the tightened rubric.

## What this does not measure

Whether the agent repairs a catch when told. Replay only shows what would have been flagged

## No drift

Violation rate does not rise with turn number in either repo. pr-lens-app is flat at about 2.5% through turns 1 to 5, 6 to 15 and 16 onward. coldtea falls from 5.8% early to 1.3% late, because the big new-file writes happen early. Agents break these rules from the first edit at a steady rate; they do not start well and drift (in my test)

## Reproduce

```
abide compile                                          # in the repo, once
abide replay claude --json > replay.json     # or codex, or opencode; run inside the repo
```

Aggregates for this run are in `results-2026-09-18.json`. Hunks are not published; they are private code.
