# Oneshot

One orchestrator. One label. Zero human gates.

Oneshot takes a GitLab issue in [`arbisoft/workstreamai`](https://gitlab.arbisoft.com/arbisoft/workstreamai)
carrying the label **`Loop`** and drives it — unattended — to **`Ready For Deployment`**:
recall prior art, research, plan, implement, brainstorm test cases, review, verify in a real
browser, open and merge the MR, deploy to the demo server, QA the deployed build, record a demo,
write a memory card so the next similar ticket starts warm, and document the ticket and the MR.

It is the successor to [`one-loop`](https://github.com/HassamAzam/one-loop), and it is a
different shape on purpose.

## Why this is not One Loop v2

One Loop is a **distributed system**: seven peer loops on independent timers, none of which owns
a ticket. That is *why* it needs a GitLab label state machine — labels are the consensus
substrate. Hence the closed label set, the swap semantics, a `label-guard` hook that re-reads
live GitLab before every mutation, a claim-by-note-then-verify race protocol, and authenticated
`HANDOFF:` markers parsed back out of Slack messages.

Oneshot is **one process with a queue**. Consensus is not a problem you have when there is one
owner.

| One Loop | Oneshot |
|---|---|
| 9-label state machine, 11 transitions | `Loop` in → `Ready For Deployment` out. Nothing between. |
| `label-guard.js` + `config/labels.json` | deleted |
| claim → post note → re-fetch → verify → roll back | one SQLite row |
| `HANDOFF:` markers + route table | a phase returns a value to its caller |
| 7 Slack apps, 7 bot tokens | 1 app, 1 token, 1 channel |
| 7 GitLab PATs | 1 |
| progress visible as label churn | a Slack card, edited in place |

Roughly 40% less code, and more capability.

## The conductor is code, not a model

`src/index.ts` is a deterministic TypeScript state machine. It schedules, validates, retries and
reaps. An LLM runs only *inside* a phase, plus a Haiku narrator that turns a phase's structured
result into a sentence for Slack.

Three things fall out of that:

1. **"Clear the context between tickets" is free.** The conductor has no context. Every phase is
   a fresh `query()` that is never resumed; when a run ends there is nothing to clear but files,
   and those get reaped.
2. **Runs are replayable.** A run is a journal of phase artifacts, so re-entering at phase 11
   costs nothing for phases 0–10.
3. **Spend goes to the work**, not to an orchestrator re-reading its own state every minute.

## Pipeline

```
 issue labelled `Loop`
   0  recall          Haiku     prior art from past runs
   1  research        Opus 5    trace the code path, state blast radius
   2  plan            Opus 5    phased plan
   3  implement       Opus 5    commits on oneshot/ticket-<iid>-<slug>
   4  testcases    ∥  Opus 5    ONE shared case list, written against real code
   5  review       ∥  Opus 5    findings ──► back to 3 (max 3 laps)
   6  verify          Sonnet 5  dev server + Playwright, runs THE list
                                fail ──► back to 3 (max 2 laps)
   7  ui-evidence  ∥  Sonnet 5  screenshots
   8  mr           ∥  Sonnet 5  MR + description
   9  merge           code      merge into dev — dev is final, nothing promotes on
  10  deploy          Sonnet 5  guarded agent: runs the deploy script,
                                diagnoses failures, bounded retries
  11  qa              Opus 5    THE list again, on the deployed build
                                fail ──► back to 3 (max 2 laps), and the lap
                                re-runs 8 → 9 → 10 so the fix actually reships
  12  demo         ∥  Sonnet 5  recorded walkthrough
  13  memorize     ∥  Haiku     memory card for future recall
  14  document        Haiku     ticket note (links the card) + MR note + uploads
  15  close           code      label → Ready For Deployment, teardown

  ∥  runs concurrently with the phase above it

  ⟨R⟩ the optional `Review` label adds three human pauses to this same list —
      before 3, before 5, and inside 9. Nothing else changes: no phase is
      added, removed or reordered. See "Optional human review gates".
```

`merge` and `close` are **code, not sessions**. No model holds a merge tool, which is why One
Loop's approval-label guard has nothing left to guard.

`deploy` used to be code too, and stopped being. The script is still the only sanctioned path to
the box, but a failed deploy needs a diagnostician — read the remote build log, check supervisor
state, pick `--npm`/`--pip` from the actual diff, retry within a cap — and none of that is
expressible as a return code. Safety moved from "no model holds the tool" to
`hooks/deploy-guard.cjs` (allowlisted hosts, allowlisted remote verbs, **fails closed**) plus a
deterministic conductor check afterwards: the deployed SHA must contain this run's merge SHA and
the site must answer 200, or the agent's verdict is overruled.

**Phase 4 exists so `verify` and `qa` execute the same list.** Without it each invents its own
scenarios, and a green local run and a green demo run cover different ground — you cannot
compare them, so the QA pass means less than it looks.

**It runs after `implement`, not before.** Writing the cases against real code buys concrete
steps — actual component names, routes, ids and error strings — instead of the approximations
you get from a plan. The cost is a list authored with the diff in view, which is how a case
list quietly ratifies a bug rather than catching it, so the prompt makes the acceptance
criteria the oracle and the diff merely the vocabulary: where the two disagree, the case is
written to the criteria and is expected to fail. `implement` therefore works from the plan
alone; on a cycle lap the cases already exist and are handed back to it. They are never
re-authored — one list, three executions, or the runs cannot be compared.

**A `qa` failure is not the same shape as a `review` failure.** It happens after the merge and
the deploy, so a lap back to `implement` is worth nothing unless `mr → merge → deploy` run again
on the way forward. They do: a cycle marks every phase in the window as owing a re-run, which is
also why a lap costs so much more from phase 11 than from phase 5.

**Full auto.** There are no human gates. The only thing that stops a run is `BLOCKED` — a deploy
the agent itself gave up on, a cycle cap exhausted, an unresolvable MR conflict, GitLab
unreachable past the breaker, or a quota park. That posts an @mention and applies `Needs Human`.

## Optional human review gates

Full auto, by default, for every ticket — the paragraph above is still true and stays true. This
is an **off-by-default, opt-in mode** for the ticket that wants a second look, not a second label
state machine: it does not touch the zero-human-gates default, and it cannot, structurally,
because every check it adds is an *additional* `labels.includes('Review')` guard around code that
already runs unconditionally. A ticket with no `Review` label drives exactly as described above,
with the exact same phases, the exact same code paths, and the exact same absence of a gate.

Why bother, given `README`'s own opening line and `docs/PLAN.md`'s "per your call: zero human
gates"? Because that call was about the *default*, and `docs/HOOKS.md`'s decision rule — structure
where the constraint can be made impossible, a hook where the model must not misuse a tool it
holds — has a third row this mode fills without touching either of the first two: a ticket a human
*chooses* to slow down for its own reasons (a sensitive module, a first run of a new kind of
change) should be able to, without every OTHER ticket paying for it and without resurrecting
`label-guard.js`'s closed label-state machine that v2 deliberately deleted (README's "Why this is
not One Loop v2", above).

Put the `Review` label on a ticket **alongside** `Loop` and three pause points activate. **Slack is
the primary approval channel for the two model-adjacent gates** — Oneshot posts the request as a
reply in the ticket's existing Slack thread (the same thread the status card and every milestone
already post into) and waits for a reply THERE; GitLab receives only an audit note once a round
resolves, never the request itself. That is a deliberate change from an earlier version of this
mode, which asked and read on the ticket instead — reviewing a plan or a test-case list is more
natural where the run's own status already lives, and the ticket stays a record of what happened
rather than a second inbox to poll.

```
 … plan ──▶[ R1 approve the plan ]──▶ implement ──▶ testcases ──▶[ R2 approve the case list ]──▶ review …
 … mr ──▶[ R3 a human merges the MR ]──▶ deploy ──▶ qa ──▶ demo ──▶ close

 R1, R2   a Slack reply of `approved` releases the pause; anything else is feedback
 R3       no keyword — the MR's own state turning `merged` is the signal
```

1. **Plan approval** — after phase 2 (`plan`), before phase 3 (`implement`). Oneshot posts the
   plan itself into the ticket's Slack thread and the run **parks**.
2. **Test-case approval** — after phase 4 (`testcases`), before phase 5 (`review`). The list of
   cases this run intends to verify is posted into the same thread, and the run **parks**. It
   sits here, and not after `qa`, because this is the last point at which approving still
   changes anything: an edge case added here is carried into `review`, into the MR, and into
   the `qa` run that follows. The same reply taken after `qa` would land on code that had
   already been reviewed and merged, where it could only become a follow-up ticket — a gate
   that cannot change what it guards is decoration. It carries no verdict, deliberately: `qa`
   has not run yet, and there is no result to summarise.
3. **The merge itself** — inside phase 9 (`merge`), still pure code, still no model. On a
   Review ticket Oneshot **never accepts the MR**, however green the pipeline or complete the
   approvals: it opens the MR and from there only watches. Merging — and therefore deploying —
   is a person's decision end to end, because it is the last irreversible step and that is
   precisely the step this label exists to reserve for a human. The phase parks until the MR's
   own state reads `merged`, whoever merged it and whenever, then the run carries on into
   `deploy → qa` by itself. Because that decision is measured in hours, the question is put to
   GitLab every 30 minutes (`MERGE_POLL_MS`); ticks in between park without a network round trip.
**Reply `approved`** (that exact word, case-insensitive, trimmed — not a substring of a longer
reply) in the thread to release a pause. **Any other reply is feedback, and the two gates treat it
differently:**

- The **plan gate** re-runs `plan` with it appended, and posts the revised plan back into the
  same thread for another round.
- The **test-case gate** reads it as edge case(s) to add rather than a reason to redo any work:
  each line of the reply becomes a new case, appended straight into `testcases.json` (see
  `appendEdgeCases()` in `src/conductor/reviewgate.ts`), and the SAME gate asks again in the same
  thread with the updated list — no phase re-runs, no cycle back to `implement`. Because this
  happens before `review`, those cases are part of what this run actually verifies.

Either way, a round's outcome reaches GitLab only as an `addIssueNote` audit record — "the plan was
approved", "here is the approved test-case list" — posted once the gate actually resolves. There is no cap on how many rounds either gate can take.

**New Slack scope, and it is a manual step.** Every OTHER Slack call this app makes only posts or
edits a message (`chat.postMessage` / `chat.update`), which the existing `chat:write` scope covers.
Reading a reply back — `conversations.replies`, added for these two gates — needs
`channels:history` (a public channel) or `groups:history` (a private one) granted to the bot token
as well. A Slack token cannot grant itself a new scope, so **a human has to add it in the Slack API
console** (the app's OAuth & Permissions page → Bot Token Scopes → add the scope → reinstall the
app to the workspace) before either gate can see a reply at all. Skip it and a gate is not
broken so much as permanently `pending`: the request goes out, `conversations.replies` comes back
`missing_scope`, and every following check reads that same empty answer until the scope is added —
a visible stall, not a silent one, and reversible with no other change once granted. See the scope
requirement documented again at `threadReplies()`'s own header in `src/lib/slack.ts`.

**Parked is not `Needs Human`.** A block swaps the ticket's label and needs a person to remove it;
a park changes no label, sends no @mention, and is picked up by the next tick's ordinary scan
exactly like a `running`/`aborted` resumption — the *only* new mechanism here is the label check
and the reply-polling, described in `src/conductor/reviewgate.ts`'s file header. It also holds no
dispatch slot, no port and no promotion window between checks, so a Review-labelled ticket parked
for a slow reviewer does not starve every other ticket the way a naive "just wait inside the
phase" implementation would.

Plain `--ticket <iid>` has no scan loop behind it, though — it runs one pass and exits, parked or
not, so a Review-gated ticket driven that way needs someone to notice the Slack reply and re-run
the command by hand. `npm start -- --ticket <iid> --follow` closes that gap: it keeps the process
alive and re-checks that SAME ticket — never anything else the board might also be claimable for —
every three minutes (`FOLLOW_TICK_MS`) until the run reaches `done` (exit 0) or a genuine `blocked`
(exit non-zero, reason printed). A `parked` run is re-checked on every one of those ticks and never
gives up on its own: it keeps asking until the thread answers with `approved` or with feedback,
which is what actually picks up a human's reply without a manual re-invoke. A transient failure to
read the ticket from GitLab is retried the same way rather than ending the process.

Three minutes rather than the watcher's `TICK_MS` minute, because a parked run re-enters the
pipeline on every tick and any phase without a recorded success is re-attempted from scratch each
time — a `skip`-on-fail phase like `recall` burns a full model lap per tick for as long as a human
takes to reply. The slower cadence still reads a reply promptly while spending a third as much.

## Mobilizing agents

Sixteen phases deep, and most of them spend their time waiting — on a webpack build, on a
GitLab poll, on a browser. Four kinds of concurrency shorten the wall clock, and none of them
weakens an invariant.

**Parallel phase groups.** A `group` in `config/phases.json` marks consecutive phases that read
the same inputs and write disjoint artifacts. The runner starts them together and then processes
their outcomes *in phase order*, so the first failure still owns control flow and a group is
never a way for a later phase to overrule an earlier one. Three today: `testcases ∥ review`
(both consume only `implement`, neither reads the other), `ui-evidence ∥ mr` (a browser pass and
a git push — disjoint tools, disjoint writes), `demo ∥ memorize` (nothing in common at all).

**Parallel subagents inside a phase.** `review` dispatches `backend-reviewer-agent`,
`frontend-reviewer-agent` and `util-reuse-agent` in a single message, so a full-stack diff gets
three specialists at once instead of three specialists in a row.

**Pipelined tickets.** `concurrency` is 2, and the tick loop keeps scanning while runs are in
flight. What used to force this to 1 was real: the deploy script ships the TIP of `dev`, so two
runs merging inside the `merge → deploy → qa` window put both changes on the demo box and QA's
verdict stops being attributable to either. That is now stated precisely rather than
approximated by a global serialisation — `src/lib/promotion.ts` is an in-process FIFO mutex held
from `merge` until `qa` passes or the run ends. Only the window where attribution lives is
serialized; everything else pipelines.

**The port pool is the real ceiling.** `verify` and `ui-evidence` run a dev server, and
`PORT_POOL` (3 by default) bounds how many can at once. A run leases its port when it first
reaches a phase that needs one — not when it leases its worktree, because holding 8001 through
forty minutes of `research` buys nothing and starves the pool.

## Quick start

```sh
git clone https://github.com/HassamAzam/oneshot.git && cd oneshot
npm install
npm start                                  # no .env? an interactive wizard runs first
```

`npm start` with no `.env` hands off to a setup wizard that reuses the GitLab token already in
`~/.claude.json`, detects your repo clones, and warns before configuring a remote telemetry
endpoint. Then `npm run verify` (deps → hooks → doctor) is the gate. It checks auth, config coherence, paths, GitLab reachability and
branch protection, that every guard script is present and its test suite passes, and that the
deploy target is configured. It exits non-zero on anything that would only surface as a confusing
failure three phases into a real ticket.

- **Auth:** the Agent SDK uses the same credential as Claude Code — if `claude login` works here,
  phases run with no API key. **Never set `ANTHROPIC_API_KEY`.** See below.
- **Kill switches:** `touch state/PAUSE` freezes everything, including sessions already mid-phase.
  `state/PAUSE-QUOTA` is the machine's own park after a usage limit and clears itself — a
  separate file precisely so nothing automatic ever lifts a pause you set.
- **Dry run:** `DRY_RUN=1 npm start` runs every phase and denies every write. This is how you
  watch the pipeline drive a real ticket without touching it.

## Guardrails

Structure first, hooks only for what structure cannot reach:

| Layer | Used when | Evadable? |
|---|---|---|
| Structure — tool absence, `cwd`, code-not-model | the constraint can be made impossible | no |
| Hook | the model holds the tool but must not use it this way | no |
| Schema | the output shape is checkable | no |
| Skill / prompt | judgment, taste, method | yes — it's advice |

The guards (`npm run hooks:verify` — offline assertions, no network, no session):

- **`pause-check`** — the brake. Denies side-effectful tools while paused; denies all GitLab
  calls while the VPN breaker is open. Reads stay allowed, so an interrupted phase can still
  write a coherent summary.
- **`write-scope`** — per-phase write allowlist, plus two absolute denials for every phase: the
  Oneshot runtime itself, and the read-only context repo. It **realpath-resolves before
  comparing**, which is load-bearing: each worktree has `.claude/` symlinked into `~/Documents/erp`
  so phases get the real skills, and a prefix-only check would let an `implement` phase rewrite
  the skills that govern it.
- **`git-guard`** — no force-push ever; no push to `dev`/`stage`/`master`/`main`; no push to any
  ref but the leased branch; no protected-branch deletes; no `remote set-url`; no `gh`/`glab`;
  and no git command whose working directory escapes the worktree. `~/Documents/erp` is a live
  repo with a real remote on this machine, and a `git commit -am` with the wrong cwd lands there.
  `--no-verify` is deliberately allowed — the husky pre-commit hook is broken locally.
- **`budget-gate`** — refuses a phase whose per-phase, per-ticket, per-window or per-day weighted
  token ceiling is already spent.
- **`deploy-guard`** — the only remote-execution guard, and the reason phase 10 can be an agent.
  Outside `deploy`, `ssh`/`scp`/`rsync`/`sftp` are denied outright — no other phase has any
  business on another machine. Inside `deploy` it permits the vendored `scripts/deploy-wsai.sh`
  and permits remote verbs only when the parsed `user@host` is in `config/deploy.json`'s
  `allowedHosts`; an unparseable target is denied, and `git push`/`gh`/`glab` are denied in this
  phase regardless. Local commands pass through untouched, so reading a log is never blocked.

**`deploy-guard` fails closed; the other four fail open, and that asymmetry is deliberate.** A
guard that crashes must not wedge a 90-minute phase, so a spawn error, a timeout or non-JSON
output from `pause-check`, `write-scope`, `git-guard` or `budget-gate` is logged loudly and
treated as allow — they are policy on operations the pipeline is otherwise structured to
survive. `deploy-guard` is not: it is the last thing between a confused phase and a live demo
server, with no human in the path, so `src/conductor/hooks.ts` keeps a `FAIL_CLOSED` set and
turns any failure of that script into a deny.

**Guards are passed to the SDK in-process, not installed into `~/.claude/settings.json`.** They
travel with the repo, so a fresh clone is protected with no install step, and your own
interactive sessions are untouched *by construction* rather than by env-gating. The callbacks
shell out to the same `hooks/*.cjs` files the test suite exercises — one implementation, no
drift between a guard and its copy.

The original design loaded them via `settingSources: ['user']`. That dragged in the operator's
entire personal config, including a `npx`-based `statusLine` that hung every phase before its
first turn. There is no global install path any more — it would double-run every guard.

Design rationale for each, and the ones not yet built, is in [docs/HOOKS.md](docs/HOOKS.md).

## Running on a Max subscription

Dollars are the wrong unit. The SDK's `total_cost_usd` is computed locally at API list rates and,
per Anthropic, is not relevant for billing on a subscription. The real constraint is the rolling
5-hour and 7-day usage windows — **and Oneshot shares them with your own Claude Code.** An
unsupervised run does not cost you money; it costs you your own window at 4pm on a Thursday.

- **Token ceilings (always on).** Every session's counts are weighted into input-token-equivalents
  — `in×1 + out×5 + cache-write×1.25 + cache-read×0.1` — so one number compares across models and
  cache states. Enforced by the conductor before claiming and by `budget-gate` at `SessionStart`.
  One ticket runs **six Opus phases**, which is materially heavier than a One Loop iteration, so
  `config/budgets.json` starts conservative.
- **The reserve (one opt-in step).** The only first-party signal for account-wide window use is
  the `rate_limits` object Claude Code passes to an *interactive* status line; headless sessions
  never see it. Wire a harvester that tees your status-line stdin to
  `~/.claude/state/ratelimit.json` and Oneshot stands down at 70% consumed, keeping the last 30%
  yours. Without it, the token ceilings alone apply.
- **A real limit means stop, not retry.** `src/lib/quota.ts` matches the reset strings, parses the
  time, and writes `state/PAUSE-QUOTA`, which clears itself. 529/overloaded and "temporarily
  limiting requests (not your usage limit)" are explicitly *not* treated as quota events.

### Keep it on the subscription

`ANTHROPIC_API_KEY` outranks subscription OAuth, and in headless/SDK mode Claude Code uses a
detected key **silently, with no prompt** — the documented way a subscription fleet becomes a
metered bill.

`src/lib/config.ts` builds session env from scratch (the SDK's `env` option *replaces* rather
than merges, which is what makes it a control) and **deletes** `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}`. An
empty value is not safe — it still wins its precedence slot — so they are deleted, not blanked.
`npm run doctor` reports which credential is in play and flags an `apiKeyHelper` in
`~/.claude/settings.json`, because phases load user settings and a helper *would* run. The 1M
context window is disabled fleet-wide: it draws on purchased credits even when subscription
allowance remains, and that *is* a real charge.

## Surviving a VPN drop

GitLab and the demo box both sit behind FortiClient. Without a breaker, a dropped tunnel is the
most expensive thing this system can do — every phase burns its full timeout on calls that cannot
succeed. `src/lib/reachability.ts` runs three states: `ok` → `degraded` after 2 consecutive
failures → `recovering` on the first success → `ok` only after 2 more. `recovering` is what stops
a 5-second blip from flapping the run and the Slack channel.

**5xx counts as down** — GitLab answering 500, or a captive portal answering for it, means work
cannot proceed either way. **401/403 does not**: the server answered, so a bad token is an auth
problem, and letting it trip the breaker would make a wrong `GITLAB_TOKEN` look like an outage.

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | the conductor — boot, preflight, watch loop, dispatch, drain |
| `src/conductor/` | watcher, queue, phase runner, the `merge`/`close` code phases, schemas, hook wiring, teardown |
| `src/phases/` | one module per phase: prompt, schema, tool policy |
| `src/lib/` | config + session env, SQLite, GitLab, worktrees, promotion mutex, quota, reachability, memory |
| `config/` | project + labels, per-phase model/tools/skills/groups, budgets, deploy, Slack |
| `hooks/` | guardrails — passed to the SDK in-process, never installed globally |
| `scripts/` | hook verify, `doctor`, dependency probe, the vendored deploy script |
| `docs/` | [PLAN.md](docs/PLAN.md) · [HOOKS.md](docs/HOOKS.md) |
| `state/` | gitignored — runs, artifacts, memory, SQLite |

## Status

All sixteen phases are **built**. Everything past M1 is code-complete and **unproven live** —
that distinction is the whole point of this section, and this repo has already learned six times
over that reading code is not running it.

**Proven live** through **M1**. A `Loop`-labelled ticket runs against real GitLab, producing
schema-valid artifacts that hand forward. First end-to-end run on ticket #5 (Invoices), on the
then-current order of recall → research → plan → testcases:

| phase | result | turns | weighted tokens |
|---|---|---|---|
| `recall` | skipped (no memory yet) | 20 | 79k |
| `research` | ok — 21 cited code-path steps, 5 AC, 8 stated unknowns | 40 | 461k |
| `plan` | ok — 6 steps, 10 reuse items, 8 risks | 22 | 298k |
| `testcases` | ok — 19 cases, 9 high-blast, all 8 passes run | 16 | 176k |

~1.0M weighted tokens for a researched, planned, test-cased ticket.

| M | Ships | Status |
|---|---|---|
| M0 | skeleton, config, hooks + test suite, quota, breaker, watcher, doctor | **done** |
| M1 | phase runner, schema-enforced handoffs, run journal, teardown, `recall`/`research`/`plan`/`testcases`, Slack card | **done, verified live** |
| M2 | `implement`, `review` and the review cycle | built, unproven |
| M3 | `verify`, `ui-evidence` — dev server on a leased port, Playwright, screenshots | built, unproven |
| M4 | `mr`, `merge`, `document` — MR, merge, promote, documentation, uploads | built, unproven |
| M5 | `deploy`, `qa`, `demo` — guarded deploy agent, demo-server QA, demo recording | built, unproven |
| M6 | phases 0 + 13 — memory card, index and recall | built, unproven |
| M7 | dashboard, replay, hardening hooks | partial — `deploy-guard` shipped with M5; dashboard and replay not started |

`runner.ts` stops with an explicit `BLOCKED: not built yet: phase '<name>'` rather than skipping
ahead — including for the `merge`/`close` code phases, so a run can never reach
`Ready For Deployment` without having actually merged and deployed.

## What six live failures taught this design

Every one was found by running it, not by reading it. Only the first was predicted.

| Failure | Cause | Fix |
|---|---|---|
| Phase hung 6 min at **zero turns** | `npx -y @zereight/mcp-gitlab` re-resolves against the npm registry per spawn; npm is blocked behind the same VPN GitLab needs | MCP server is a real dependency |
| Still hung after that fix | `settingSources:['user']` loads the operator's `statusLine: npx ccusage@latest`, which hangs the same way | guards passed in-process; `'user'` dropped |
| `spawn node ENOENT` | resume trusted a `worktree` path that had been deleted — a missing `cwd` reports as ENOENT and reads like a broken PATH | validate and re-lease |
| Two conductors claimed one ticket | a killed `npm` wrapper orphans its `tsx` child; and `isClaimed()` lived only in the watcher, so `--ticket` bypassed it | PID-file singleton + claim inside `runTicket` |
| Duplicate claim notes | the note was re-posted on every resumption | once per run |
| Unimplemented `code` phases skipped silently | `kind: 'code'` was treated as nothing-to-do | explicit `CODE_PHASES` registry |

The recurring lesson: **nothing in this pipeline may shell out to `npx` at run time**, and
`npm run deps:verify` now spawns every out-of-process dependency for real — because checking
that a dependency is *configured* is not the same as checking that it *runs*.
