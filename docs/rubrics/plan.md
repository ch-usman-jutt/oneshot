# Rubric — `plan`

What a good `plan.json` looks like, as checks a script can apply without a
grader session. Every check is a rule the plan prompt (`src/phases/prompts.ts`,
`plan:`) or its schema (`PLAN_SCHEMA`) already states. `scripts/eval-phase.ts`
applies them.

Scoring works as it does for recall: a sample scores the share of checks it
passes, and a ticket scores the mean over its N samples.

| Check | Passes when | Prompt rule |
|---|---|---|
| `coverage` | `acceptanceCoverage` has one entry per research acceptance criterion | "one entry per research acceptance criterion" |
| `coverage-explained` | every `partial` / `not-satisfiable` entry has a note | "say what is done instead" |
| `steps` | steps are numbered 1..k and each names at least one file | "Steps are ordered and each names the files it touches" |
| `files-real` | every step file exists at `base`, or its directory does (a new file) | none directly: a path that doesn't exist sends `implement` looking for code that isn't there |
| `no-jest` | no step touches a frontend `__tests__`, `.test.js`, `.spec.js` or snapshot file, or says Jest | "No step writes a Jest test" |
| `migrations-flag` | `migrations` is true exactly when a step has layer `migration` or touches `/migrations/` | "Set `migrations` true if any model … changes" |
| `no-feedback` | `feedbackResponse` is `[]` | "Send `[]` when there is no feedback block" |
| `read-only` | the worktree has no uncommitted changes after the run | "Do not write or modify any code" |
| `gold-files` | every `must` file from the real merged change is named in some step | the change a person merged |
| `gold-migrations` | `migrations` matches whether the real change had a migration | the change a person merged |
| `time` | the run finished inside `timeoutMin` in `config/phases.json` (20 min) | the phase's own limit |
| `turns` | the run used fewer turns than `maxTurns` (50) | the phase's own limit |
| `no-stray` | no tool call reads outside the worktree, and none edits a file | "Do not write or modify any code", and the system prompt's "stay out of" other checkouts |

`gold-files` fails only on missed files. Files outside the real change show up
in its note as `+N outside the real change`, but they don't fail the check. A
plan can reasonably touch more than what landed. A long tail of extras (the live
#179 plan named five files, and the fix touched one) is worth reading, not
auto-failing.

## What the score does not judge

Some prompt rules need a reader, not a regex, so they are left to a person:

- whether `reuse` names helpers that really do the job
- whether each research `unknown` ends up resolved, in `openQuestions` or in
  `outOfScope`, and not decided silently
- whether `risks` are concrete

`npm run replay` exists for that reading. The eval tells you which samples are
worth reading.

## Inputs

Each ticket in `evals/plan/gold.json` fixes three things so two evals differ
only by the prompt:

- **the code**: `base`, the commit the live run planned on. Each sample gets its
  own detached worktree there, removed afterwards.
- **upstream answers**: the live run's `recall.json` and `research.json`, copied
  once to `state/evals/prior/<iid>/`.
- **the ticket**: cached in `state/evals/tickets/`, with only the comments posted
  before the live run started. Later comments carry the plan gate reply, which
  names the answer.

## Cost is part of the score

This is where plan differs from recall. Recall only reports cost next to its score.
Plan scores part of it, with `time`, `turns` and `no-stray`: a plan that gets the
right files but hits its limits, or reads another repo on the way, has done its
job worse.

Tokens are **not** scored. They are reported in the `weighted` column, with
`vs live` and `vs prev`, and a sample past `phases.plan` in `config/budgets.json`
(600k) counts in `over`. A token change is a trade to decide, not a wrong answer.

The limits are the ones the live pipeline already enforces. They are not new
numbers, so a sample fails a cost check only where a live run would have been
stopped or flagged. Samples run 4 at a time, so `time` runs a little above a lone
live run.

`no-stray` allows reads inside the sample's worktree, system and temp paths
(`/usr`, `/tmp`, …) and tool folders in the home directory (`~/.pyenv`, `~/.nvm`).
Anything else is a stray: another checkout, the Oneshot repo, or any
Edit/Write call. The `stray` column shows the mean count, and the sample file
lists the calls.

The raw numbers stay next to the score too (`turns`, `weighted`, `secs`,
`vs live`, `vs prev`), because passing a limit says nothing about a change
that made the phase 50% more expensive.

`npm run eval -- plan --live` grades the live runs' own `plan.json` with no
replay, including the cost checks, which it reads from the live run's journal and
transcript. It's a free baseline, and it's how to check the grader before spending
quota. It is never saved as `previous`.
