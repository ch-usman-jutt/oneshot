/**
 * Replay ONE phase on stored tickets, N times each, and grade every answer.
 *
 * docs/FIX-PLAN.md §7: the smallest loop that can show a prompt change moved a
 * score on the same inputs. Not a framework — each wired phase is one entry in
 * PHASES: its grader, and which frozen inputs it reads.
 *
 * Inputs are frozen so two runs differ only by the prompt:
 *   - tickets are fetched from GitLab once and cached in state/evals/tickets/
 *   - recall: the memory is snapshotted once into state/evals/memory/ and
 *     copied into the dry home before every replay
 *   - plan: the live run's recall.json and research.json are copied once into
 *     state/evals/prior/<iid>/, and every sample gets its own detached worktree
 *     at the commit the live run planned on (`base` in evals/plan/gold.json)
 *
 * It runs the phase through the production runPhase — same prompt builder,
 * model tier, schema, hooks and tool policy — under DRY_RUN, whose shadow home
 * (state-dry/) keeps every side effect runPhase has (artifact, transcript,
 * quota row, event row) away from the live runs and the live board.
 *
 *   npm run eval -- recall                 # the gold tickets, 3 samples each
 *   npm run eval -- recall 247 28 --n 5
 *   npm run eval -- recall --refresh-memory  # re-snapshot memory, keep the cached tickets
 *   npm run eval -- recall --refetch         # re-read the tickets, keep the snapshot
 *   npm run eval -- plan --live              # grade the live runs' plan.json, no replay
 *
 * The two are separate because they go stale for different reasons: memory
 * grows with every completed run, while a ticket only needs re-reading when it
 * was edited. Re-reading also means asking GitLab, which only knows the ONE
 * project GITLAB_REPO_URL names today — see loadTicket.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DRY_RUN, MEMORY, ROOT, WORK_REPO, budgetConfig, phaseByName, repoIdentity } from '../src/lib/config.js';
import { allIssueNotes, getIssue } from '../src/lib/gitlab.js';
import { ticketComments } from '../src/conductor/runner.js';
import { removeReplayWorktree, replayWorktree } from '../src/lib/worktrees.js';
import { promptFor, systemPromptFor, type PromptCtx } from '../src/phases/prompts.js';
import { runPhase } from '../src/conductor/phase.js';
import { transcriptPath, type RunJournal } from '../src/lib/artifacts.js';
import type { Ticket } from '../src/phases/types.js';

// config.ts picks the state home at import time, so the flag has to be in the
// environment before this file loads — the npm script sets it. Refusing here is
// what stops a bare `tsx scripts/eval-phase.ts` overwriting a live run's artifact.
if (!DRY_RUN) {
  console.error('Run this through `npm run eval`: it needs DRY_RUN=1 so replays land in state-dry/, not state/.');
  process.exit(2);
}

const EVALS = join(ROOT, 'state', 'evals');
const LIVE_MEMORY = join(ROOT, 'state', 'memory');
const SNAPSHOT = join(EVALS, 'memory');
const TICKETS = join(EVALS, 'tickets');
const PRIOR = join(EVALS, 'prior');
const PARALLEL = 4;

type Artifact = Record<string, unknown>;
interface Check { name: string; pass: boolean; note?: string }
interface ToolCall { name: string; input: Record<string, unknown> }
/** What a grader may look at besides the answer. `gold` is the phase's own shape. */
interface GradeCtx<G> { ticket: Ticket; gold: G | undefined; prior: Record<string, Artifact | null>; base?: string; dirty: string[] }
type Grader<G = unknown> = (out: Artifact, ctx: GradeCtx<G>) => Check[];

// ---------------------------------------------------------------- graders --

/** The iids the frozen memory actually holds, from either half of it. */
function memoryIids(): Set<number> {
  const ids = new Set<number>();
  const index = join(SNAPSHOT, 'index.jsonl');
  if (existsSync(index)) {
    for (const line of readFileSync(index, 'utf8').split('\n').filter(Boolean)) {
      try { ids.add(Number(JSON.parse(line).iid)); } catch { /* a torn line is not a ticket */ }
    }
  }
  const cards = join(SNAPSHOT, 'tickets');
  if (existsSync(cards)) {
    for (const f of readdirSync(cards)) if (/^\d+\.md$/.test(f)) ids.add(Number(f.slice(0, -3)));
  }
  return ids;
}

/**
 * What the frozen memory says each run touched: its index `files` plus its card
 * text, so a path the brief names can be traced back to a run that cited it.
 */
function memoryRecords(): Map<number, string> {
  const text = new Map<number, string>();
  const index = join(SNAPSHOT, 'index.jsonl');
  if (existsSync(index)) {
    for (const line of readFileSync(index, 'utf8').split('\n').filter(Boolean)) {
      try {
        const j = JSON.parse(line) as { iid: number; files?: string[] };
        text.set(Number(j.iid), (j.files ?? []).join('\n'));
      } catch { /* a torn line is not a ticket */ }
    }
  }
  const cards = join(SNAPSHOT, 'tickets');
  if (existsSync(cards)) {
    for (const f of readdirSync(cards)) {
      if (!/^\d+\.md$/.test(f)) continue;
      const iid = Number(f.slice(0, -3));
      text.set(iid, `${text.get(iid) ?? ''}\n${readFileSync(join(cards, f), 'utf8')}`);
    }
  }
  return text;
}

/**
 * A file path: directory-qualified with any extension, or a bare root-level
 * name (README.md, ThemedApp.js) with a source extension — a bare `x.y` alone
 * would catch "e.g" and version numbers.
 */
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.\w+|\b[\w-]+(?:\.[\w-]+)*\.(?:py|jsx?|tsx?|mjs|cjs|json|md|html|s?css|ya?ml|sql|sh|vue)\b/g;

const paths = (text: string): string[] => (text.match(PATH_RE) ?? []).map((p) => p.replace(/^\.\//, ''));

interface RecallGold { must: number[]; ok: number[]; why: string }

/** docs/rubrics/recall.md, check for check. Judges the answer only — see outOfMemory. */
const gradeRecall: Grader<RecallGold> = (out, { ticket, gold }) => {
  const prior = (out.priorTickets as Array<{ iid: number; gotchas?: string[] }>) ?? [];
  const cited = prior.map((p) => Number(p.iid));
  const brief = String(out.brief ?? '').trim();
  const known = memoryIids();
  // Out-of-scope work that reached the answer: a file path no cited run touched
  // is the phase's own code research (or an invention), and it is pasted into
  // research, plan, implement and review all the same.
  const citedText = cited.map((i) => memoryRecords().get(i) ?? '').join('\n');
  // Whole paths, not substrings: components/Button.tsx is not src/components/Button.tsx.
  // A bare name is grounded by a cited file of that name in any directory.
  const citedPaths = new Set(paths(citedText));
  const citedNames = new Set([...citedPaths].map((p) => p.split('/').pop()!));
  const named = paths([brief, ...prior.flatMap((p) => p.gotchas ?? [])].join('\n'));
  const ungrounded = [...new Set(named)].filter((p) => !citedPaths.has(p) && !(!p.includes('/') && citedNames.has(p)));
  const checks: Check[] = [
    { name: 'no-self', pass: !cited.includes(ticket.iid) },
    {
      name: 'real',
      pass: cited.every((i) => known.has(i)),
      note: cited.filter((i) => !known.has(i)).map((i) => `#${i} not in memory`).join(', '),
    },
    {
      name: 'empty-is-empty',
      pass: (cited.length === 0) === (brief === ''),
      note: cited.length === 0 && brief ? `no tickets but a ${brief.length}-char brief` : '',
    },
    {
      name: 'cites-iid',
      pass: cited.every((i) => new RegExp(`#${i}\\b`).test(brief)),
    },
    { name: 'short', pass: brief.length <= 1000, note: `${brief.length} chars` },
    { name: 'files-grounded', pass: ungrounded.length === 0, note: ungrounded.join(', ') },
  ];
  if (gold) {
    const missing = gold.must.filter((i) => !cited.includes(i));
    const extra = cited.filter((i) => !gold.must.includes(i) && !gold.ok.includes(i));
    checks.push({
      name: 'gold',
      pass: missing.length === 0 && extra.length === 0,
      note: [...missing.map((i) => `missed #${i}`), ...extra.map((i) => `cited #${i}`)].join(', '),
    });
  }
  return checks;
};

interface PlanGold { base: string; must: string[]; ok: string[]; migrations: boolean; why: string }

/** Every path and every directory in the tree at `base`, read once per commit. */
const trees = new Map<string, { files: Set<string>; dirs: Set<string> }>();
function treeAt(base: string): { files: Set<string>; dirs: Set<string> } {
  let t = trees.get(base);
  if (t) return t;
  const files = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', base], {
    cwd: WORK_REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\n').filter(Boolean));
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  t = { files, dirs };
  trees.set(base, t);
  return t;
}

/** A plan names `path/to/file.py:42` or a directory as often as a bare path. */
const planPath = (f: string): string => f.trim().replace(/^\.\//, '').replace(/:\d+(?:-\d+)?$/, '').replace(/\/$/, '');

/** A frontend unit test: plan's prompt forbids them (the Jest toolchain has rotted and CI never runs it). */
const JEST_RE = /^frontend\/.*(?:__tests__|__snapshots__|\.(?:test|spec)\.[jt]sx?$|\.snap$)/;

/** docs/rubrics/plan.md, check for check. Every check is a rule the plan prompt states. */
const gradePlan: Grader<PlanGold> = (out, { gold, prior, base, dirty }) => {
  const steps = (out.steps as Array<{ n: number; what: string; files: string[]; layer: string }>) ?? [];
  const coverage = (out.acceptanceCoverage as Array<{ status: string; note: string }>) ?? [];
  const criteria = ((prior.research?.acceptanceCriteria as unknown[]) ?? []).length;
  const files = [...new Set(steps.flatMap((s) => s.files.map(planPath)).filter(Boolean))];
  const tree = base ? treeAt(base) : null;
  // A file the plan creates is real when its directory already is, or that
  // directory's parent is — a first test often opens a new __tests__/.
  const up = (f: string, k: number): string => f.split('/').slice(0, -k).join('/');
  const unreal = tree ? files.filter((f) => !tree.files.has(f) && !tree.dirs.has(f) && !tree.dirs.has(up(f, 1)) && !tree.dirs.has(up(f, 2))) : [];
  const jest = steps.filter((s) => s.files.some((f) => JEST_RE.test(planPath(f))) || /\bjest\b/i.test(s.what));
  const migrates = steps.some((s) => s.layer === 'migration' || s.files.some((f) => f.includes('/migrations/')));
  const unexplained = coverage.filter((c) => c.status !== 'covered' && !c.note.trim()).length;
  const checks: Check[] = [
    { name: 'coverage', pass: coverage.length === criteria, note: `${coverage.length} of ${criteria} criteria` },
    { name: 'coverage-explained', pass: unexplained === 0, note: unexplained ? `${unexplained} partial/not-satisfiable without a note` : '' },
    {
      name: 'steps',
      pass: steps.length > 0 && steps.every((s, i) => s.n === i + 1 && s.files.length > 0),
      note: steps.filter((s, i) => s.n !== i + 1 || !s.files.length).map((s) => `step ${s.n}`).join(', '),
    },
    { name: 'files-real', pass: unreal.length === 0, note: unreal.join(', ') },
    { name: 'no-jest', pass: jest.length === 0, note: jest.map((s) => `step ${s.n}`).join(', ') },
    { name: 'migrations-flag', pass: out.migrations === migrates, note: `flag ${out.migrations}, steps ${migrates}` },
    { name: 'no-feedback', pass: ((out.feedbackResponse as unknown[]) ?? []).length === 0 },
    { name: 'read-only', pass: dirty.length === 0, note: dirty.slice(0, 5).join(', ') },
  ];
  if (gold) {
    const missed = gold.must.filter((f) => !files.includes(f));
    const extra = files.filter((f) => !gold.must.includes(f) && !gold.ok.includes(f));
    checks.push(
      {
        name: 'gold-files',
        pass: missed.length === 0,
        note: [...missed.map((f) => `missed ${f}`), extra.length ? `+${extra.length} outside the real change` : ''].filter(Boolean).join(', '),
      },
      { name: 'gold-migrations', pass: out.migrations === gold.migrations },
    );
  }
  return checks;
};

/**
 * One entry per wired phase. `prior` is which live-run artifacts the phase is
 * handed, frozen on first use; a phase whose cwd is the worktree gets its own
 * detached checkout at the gold `base` per sample.
 */
interface PhaseEval {
  grade: Grader<never>;
  memory?: boolean;
  prior?: string[];
  stray?: (calls: ToolCall[], worktree?: string) => string[];
  /** Time, turns and strays become checks in the score, not only columns beside it. Tokens never do. */
  scoreCost?: boolean;
}
const PHASES: Record<string, PhaseEval> = {
  recall: { grade: gradeRecall, memory: true, stray: outOfMemory },
  plan: { grade: gradePlan, prior: ['recall', 'research'], stray: outsideWorktree, scoreCost: true },
};

/**
 * The tool calls that reached outside the memory. recall reads memory and
 * nothing else (prior-art-recall: "Reads the run memory only; never opens the
 * work repo, never traces code") — the live #193 run read index.jsonl and then
 * spent 44 calls exploring the workstreamai frontend. The prompt names memory
 * by absolute path, so a call that names no absolute path at all is working
 * relative to the conductor repo, which is outside it too.
 *
 * Reported beside the cost, never scored: the score judges the answer, and
 * exploration that leaves the answer clean is spend, not a wrong answer.
 * Exploration that leaks INTO the answer is caught by files-grounded and
 * empty-is-empty.
 */
function outOfMemory(calls: ToolCall[]): string[] {
  const inMemory = (p: string): boolean => p.startsWith(MEMORY) || p.endsWith('/prior-art-recall/SKILL.md');
  const out: string[] = [];
  for (const c of calls) {
    if (c.name === 'StructuredOutput' || c.name === 'Skill' || c.name === 'TodoWrite') continue;
    const paths = ['Read', 'Glob', 'Grep', 'LS'].includes(c.name)
      ? [String(c.input.file_path ?? c.input.path ?? '')]
      : c.name === 'Bash'
        ? String(c.input.command ?? '').match(/\/[^\s'"|;&)<>]+/g) ?? []
        : null;
    if (!paths) { out.push(c.name); continue; }
    if (!paths.length || !paths.every((p) => p && inMemory(p))) {
      out.push(`${c.name} ${paths.find((p) => !inMemory(p)) || '(cwd)'}`);
    }
  }
  return out;
}

/** Paths any shell command may name without leaving the job: devices, tools, temp, and ~/.<tool> dirs like ~/.pyenv. */
const SYSTEM_PATH = new RegExp(`^(?:/(?:dev|usr|bin|sbin|opt|tmp|private/tmp|var/folders)/|${homedir()}/\\.)`);

/** Absolute and ~/ paths in a shell command — only where a word starts, so the tail of a relative glob is not one. */
const shellPaths = (cmd: string): string[] =>
  (cmd.match(/(?<=^|[\s'"=(])~?\/[^\s'"|;&)<>:]+/g) ?? []).map((p) => p.replace(/^~/, homedir()));

/**
 * The tool calls that left the worktree or changed a file. plan reads its own
 * checkout and nothing else ("Do not write or modify any code"), so an edit is
 * a stray wherever it lands, and so is a read of another repo — the prompt
 * tells every phase the other checkouts on this machine are live.
 */
function outsideWorktree(calls: ToolCall[], worktree?: string): string[] {
  if (!worktree) return [];
  const inside = (p: string): boolean => p.startsWith(worktree) || SYSTEM_PATH.test(p);
  const out: string[] = [];
  for (const c of calls) {
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name)) {
      out.push(`${c.name} ${String(c.input.file_path ?? '')}`);
      continue;
    }
    const paths = ['Read', 'Glob', 'Grep', 'LS'].includes(c.name)
      ? [String(c.input.file_path ?? c.input.path ?? '')].filter(Boolean)
      : c.name === 'Bash'
        ? shellPaths(String(c.input.command ?? ''))
        : [];
    const away = paths.find((p) => !inside(p));
    if (away) out.push(`${c.name} ${away}`);
  }
  return out;
}

/**
 * Time, turns and strays as checks, against the phase's own limits in
 * config/phases.json. Tokens are left out on purpose: they stay in the
 * `weighted` column and `over`, reported and never scored.
 */
function costChecks(secs: number, turns: number, strays: string[] | null, limits: { maxTurns: number; timeoutSecs: number }): Check[] {
  const checks: Check[] = [
    { name: 'time', pass: secs < limits.timeoutSecs, note: `${Math.round(secs)}s of ${limits.timeoutSecs}s` },
    { name: 'turns', pass: turns < limits.maxTurns, note: `${turns} of ${limits.maxTurns}` },
  ];
  if (strays) checks.push({ name: 'no-stray', pass: strays.length === 0, note: strays.slice(0, 3).join(', ') });
  return checks;
}

/**
 * The tool calls one sample made. runPhase APPENDS to the tee, and every eval
 * of the same iid and sample number lands on the same file, so only the bytes
 * written after `from` belong to this sample.
 */
function toolCalls(tee: string, from: number): ToolCall[] {
  if (!existsSync(tee)) return [];
  const calls: ToolCall[] = [];
  for (const line of readFileSync(tee).subarray(from).toString('utf8').split('\n').filter(Boolean)) {
    try {
      const m = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) continue;
      for (const b of m.message.content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
        if (b.type === 'tool_use') calls.push({ name: String(b.name), input: b.input ?? {} });
      }
    } catch { /* a torn line is not a call */ }
  }
  return calls;
}

// ----------------------------------------------------------------- inputs --

/**
 * The ticket exactly as the live run's recall session was shown it.
 *
 * runPhase's tee keeps the stream but not the prompt; the CLI's own session log
 * under ~/.claude/projects keeps both, and its first user message IS
 * ticketBlock() followed by the phase text. Parsing it back gives the same
 * bytes the live run saw, and works with GitLab off the VPN.
 */
function ticketFromTranscript(iid: number): Ticket | null {
  const tee = join(ROOT, 'state', 'runs', String(iid), 'transcripts', 'recall-lap0.jsonl');
  if (!existsSync(tee)) return null;
  const sid = /"session_id":"([^"]+)"/.exec(readFileSync(tee, 'utf8'))?.[1];
  const projects = join(homedir(), '.claude', 'projects');
  const log = sid && readdirSync(projects).map((d) => join(projects, d, `${sid}.jsonl`)).find(existsSync);
  if (!log) return null;
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    const m = JSON.parse(line || '{}') as { type?: string; message?: { content?: unknown } };
    if (m.type !== 'user') continue;
    const c = m.message?.content;
    const text = typeof c === 'string' ? c : (c as Array<{ text?: string }>).map((b) => b.text ?? '').join('');
    const block = text.split("\n\nSearch this system's memory")[0]!.split(/\n\n### Documents (?:attached|linked)/)[0]!;
    const head = /^## Ticket #(\d+) — (.*)\n.*\nLabels: (.*)\n\n### Description\n/.exec(block);
    if (!head) return null;
    const rest = block.slice(head[0].length);
    const cut = rest.search(/\n(?:### Comments \(\d+\)|\(no comments\))/);
    const body = cut >= 0 ? rest.slice(0, cut) : rest;
    const comments = cut >= 0 ? rest.slice(cut).split(/\n--- comment \d+ ---\n/).slice(1) : [];
    return {
      iid, title: head[2]!,
      labels: head[3] === 'none' ? [] : head[3]!.split(', '),
      description: body.trim() === '(empty)' ? null : body,
      notes: comments,
    };
  }
  return null;
}

/**
 * The project the live run on this iid belonged to, or null with no live run.
 *
 * Memory and the gold set hold iids only, and those are per project: the gold
 * tickets were run on arbisoft/workstreamai, while GITLAB_REPO_URL now names
 * arbisoft/erp, whose #74 is a different ticket. Asking GitLab for such an iid
 * would grade recall on the wrong ticket and say nothing about it.
 */
/** When the live run on this iid started, so a re-read ticket shows only the comments it saw. */
function liveRunStart(iid: number): number | undefined {
  const file = join(ROOT, 'state', 'runs', String(iid), 'run.json');
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, 'utf8')) as { createdAt?: number }).createdAt;
}

function liveRunProject(iid: number): string | null {
  const file = join(ROOT, 'state', 'runs', String(iid), 'run.json');
  if (!existsSync(file)) return null;
  const url = String((JSON.parse(readFileSync(file, 'utf8')) as { url?: string }).url ?? '');
  return url.split('/-/issues/')[0] || null;
}

/**
 * What the live run's first attempt at this phase cost — lap 0, because later
 * laps run on a different journal and some were cut short by a gate.
 */
function liveCost(iid: number, phase: string): { turns: number; weighted: number; secs: number } | null {
  const file = join(ROOT, 'state', 'runs', String(iid), 'run.json');
  if (!existsSync(file)) return null;
  const phases = (JSON.parse(readFileSync(file, 'utf8')) as { phases?: Array<{ phase: string; lap: number; turns: number; weighted: number; startedAt: number; endedAt: number }> }).phases ?? [];
  const first = phases.find((p) => p.phase === phase && p.lap === 0);
  return first ? { turns: first.turns, weighted: first.weighted, secs: (first.endedAt - first.startedAt) / 1000 } : null;
}

/** The same ticket the runner builds (runner.ts fetchTicket), minus documents. */
async function loadTicket(iid: number, refetch: boolean): Promise<Ticket> {
  const cached = join(TICKETS, `${iid}.json`);
  if (!refetch && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8')) as Ticket;
  const project = liveRunProject(iid);
  const configured = repoIdentity().repo?.webUrl ?? null;
  if (project && project !== configured) {
    const offline = ticketFromTranscript(iid);
    if (!offline) throw new Error(`#${iid}: its live run was on ${project}, not ${configured ?? 'GITLAB_REPO_URL'}, and its recall transcript is gone`);
    console.log(`#${iid}: live run was on ${project} — using the prompt it saw, not GitLab`);
    mkdirSync(TICKETS, { recursive: true });
    writeFileSync(cached, JSON.stringify(offline, null, 2));
    return offline;
  }
  const res = await getIssue(iid);
  if (!res.ok || !res.data) {
    const offline = ticketFromTranscript(iid);
    if (!offline) throw new Error(`#${iid}: could not read the ticket from GitLab (${res.error ?? 'no data'}) nor from its recall transcript`);
    console.log(`#${iid}: GitLab unreachable — using the prompt the live run saw`);
    mkdirSync(TICKETS, { recursive: true });
    writeFileSync(cached, JSON.stringify(offline, null, 2));
    return offline;
  }
  const notes = await allIssueNotes(iid);
  // Never cache a ticket without its comments: the cache outlives the outage.
  if (!notes.ok || !notes.data) {
    const offline = ticketFromTranscript(iid);
    if (!offline) throw new Error(`#${iid}: could not read the ticket's comments from GitLab (${notes.error ?? 'no data'}) nor its recall transcript`);
    console.log(`#${iid}: GitLab comments unreachable — using the prompt the live run saw`);
    mkdirSync(TICKETS, { recursive: true });
    writeFileSync(cached, JSON.stringify(offline, null, 2));
    return offline;
  }
  const ticket: Ticket = {
    iid: res.data.iid,
    title: res.data.title,
    description: res.data.description,
    labels: res.data.labels,
    // Only comments from before the live run: later ones carry the answers it
    // produced and the feedback on them — a plan gate reply names the files.
    notes: ticketComments(notes.data, liveRunStart(iid)),
  };
  mkdirSync(TICKETS, { recursive: true });
  writeFileSync(cached, JSON.stringify(ticket, null, 2));
  return ticket;
}

function snapshotMemory(refresh: boolean): void {
  if (existsSync(SNAPSHOT) && !refresh) return;
  rmSync(SNAPSHOT, { recursive: true, force: true });
  cpSync(LIVE_MEMORY, SNAPSHOT, { recursive: true });
  console.log(`memory snapshot taken from ${LIVE_MEMORY} — re-check evals/*/gold.json against it`);
}

/**
 * The upstream artifacts the live run handed this phase, copied once so a
 * later live run on the same iid cannot change the eval's inputs. Delete
 * state/evals/prior/<iid>/ to re-take them.
 */
function frozenPrior(iid: number, names: string[]): Record<string, Artifact | null> {
  const dir = join(PRIOR, String(iid));
  const out: Record<string, Artifact | null> = {};
  for (const name of names) {
    const frozen = join(dir, `${name}.json`);
    const live = join(ROOT, 'state', 'runs', String(iid), `${name}.json`);
    if (!existsSync(frozen) && existsSync(live)) {
      mkdirSync(dir, { recursive: true });
      cpSync(live, frozen);
    }
    out[name] = existsSync(frozen) ? JSON.parse(readFileSync(frozen, 'utf8')) as Artifact : null;
  }
  return out;
}

/** Uncommitted changes in a sample's worktree — a read-only phase leaves none. */
function dirtyFiles(worktree: string): string[] {
  return execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((l) => l.slice(3));
}

/** Every replay starts from the snapshot, whatever the last one left behind. */
function stageMemory(): void {
  rmSync(MEMORY, { recursive: true, force: true });
  cpSync(SNAPSHOT, MEMORY, { recursive: true });
}

// ------------------------------------------------------------------- main --

interface Sample { iid: number; n: number; score: number; checks: Check[]; turns: number; weighted: number; secs: number; over: boolean; stray: number | null; error?: string }

async function pool<T>(jobs: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!(); }
  }));
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const phase = argv[0] ?? '';
  const spec = PHASES[phase];
  const cfg = phaseByName(phase);
  if (!spec || !cfg) {
    console.error(`usage: npm run eval -- <phase> [iid ...] [--n 3] [--refresh-memory] [--refetch] [--live]   phases: ${Object.keys(PHASES).join(', ')}`);
    process.exit(2);
  }
  const liveOnly = argv.includes('--live');
  const nAt = argv.indexOf('--n');
  // A live artifact is one answer; sampling it again changes nothing.
  const n = liveOnly ? 1 : nAt >= 0 ? Number(argv[nAt + 1]) : 3;
  if (!Number.isInteger(n) || n < 1) {
    console.error('--n needs a positive integer');
    process.exit(2);
  }
  if (argv.includes('--refresh')) {
    console.error('--refresh is split: --refresh-memory re-snapshots memory, --refetch re-reads the tickets.');
    process.exit(2);
  }
  const goldFile = join(ROOT, 'evals', phase, 'gold.json');
  const grade = spec.grade as Grader<unknown>;
  const gold: Record<string, { base?: string }> = existsSync(goldFile) ? JSON.parse(readFileSync(goldFile, 'utf8')).cases : {};
  const iids = argv.slice(1).filter((a, i, all) => /^\d+$/.test(a) && all[i - 1] !== '--n').map(Number);
  const targets = iids.length ? iids : Object.keys(gold).map(Number);

  if (spec.memory) {
    snapshotMemory(argv.includes('--refresh-memory'));
    stageMemory();
  }
  const worktreed = cfg.cwd === 'worktree';
  for (const iid of targets) {
    const base = gold[iid]?.base;
    if (!worktreed) continue;
    if (!base) throw new Error(`#${iid}: ${phase} reads code, so evals/${phase}/gold.json needs its \`base\` commit`);
    try {
      execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: WORK_REPO, stdio: 'ignore' });
    } catch {
      throw new Error(`#${iid}: ${base.slice(0, 10)} is not in ${WORK_REPO} — point GITLAB_REPO_URL and WORK_REPO at the ticket's project (see evals/${phase}/gold.json _about)`);
    }
  }
  const tag = new Date().toISOString().replace(/[:.]/g, '-');
  // Reported beside the score, never folded into it: the phase's own quota
  // budget and turn cap, so a runaway sample stands out.
  const budget = budgetConfig().phases?.[phase] ?? Infinity;
  const limits = { budget, maxTurns: cfg.maxTurns ?? Infinity, timeoutSecs: cfg.timeoutMin * 60 };
  const outDir = join(EVALS, phase, tag);

  const tickets = new Map<number, Ticket>();
  for (const iid of targets) tickets.set(iid, await loadTicket(iid, argv.includes('--refetch')));

  const jobs = targets.flatMap((iid) => Array.from({ length: n }, (_, k) => async (): Promise<Sample> => {
    const ticket = tickets.get(iid)!;
    const prior = frozenPrior(iid, spec.prior ?? []);
    const base = gold[iid]?.base;
    const grading = (dirty: string[]): GradeCtx<unknown> => ({ ticket, gold: gold[iid], prior, base, dirty });
    if (liveOnly) {
      // The live run's own answer, graded as it stands: a baseline that costs nothing.
      const file = join(ROOT, 'state', 'runs', String(iid), `${phase}.json`);
      const out = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Artifact : null;
      const checks: Check[] = out ? grade(out, grading([])) : [{ name: 'produced', pass: false, note: `no live ${phase}.json` }];
      const live = liveCost(iid, phase);
      const run = JSON.parse(readFileSync(join(ROOT, 'state', 'runs', String(iid), 'run.json'), 'utf8')) as { worktree?: string };
      const liveTee = join(ROOT, 'state', 'runs', String(iid), 'transcripts', `${phase}-lap0.jsonl`);
      const strays = spec.stray ? spec.stray(toolCalls(liveTee, 0), run.worktree ?? undefined) : null;
      if (out && live && spec.scoreCost) checks.push(...costChecks(live.secs, live.turns, strays, limits));
      const score = checks.filter((c) => c.pass).length / checks.length;
      return { iid, n: k, score, checks, turns: live?.turns ?? 0, weighted: live?.weighted ?? 0, secs: live?.secs ?? 0, over: false, stray: strays?.length ?? null };
    }
    const runId = `eval-${tag}-${iid}-${k}`;
    const worktree = worktreed ? replayWorktree(`eval-${phase}-${iid}-${k}-${tag}`, base!) : undefined;
    const ctx: PromptCtx = {
      ticket, runId, lap: k, worktree,
      journal: { runId, iid, title: ticket.title, phases: [] } as unknown as RunJournal,
      prior,
    };
    const tee = transcriptPath(iid, cfg.name, k);
    const from = existsSync(tee) ? statSync(tee).size : 0;
    const startedAt = Date.now();
    let res: Awaited<ReturnType<typeof runPhase>>;
    let dirty: string[] = [];
    try {
      res = await runPhase({
        iid, runId, lap: k, cfg, worktree,
        prompt: promptFor(cfg, ctx), systemPrompt: systemPromptFor(cfg, ctx),
      });
      if (worktree) dirty = dirtyFiles(worktree);
    } finally {
      if (worktree) removeReplayWorktree(worktree);
    }
    const secs = (Date.now() - startedAt) / 1000;
    const checks: Check[] = res.data ? grade(res.data, grading(dirty)) : [{ name: 'produced', pass: false, note: res.error ?? res.blocked ?? 'no output' }];
    const strays = spec.stray ? spec.stray(toolCalls(tee, from), worktree) : null;
    if (res.data && spec.scoreCost) checks.push(...costChecks(secs, res.turns, strays, limits));
    const over = res.weighted > budget || res.turns >= limits.maxTurns || secs >= limits.timeoutSecs;
    const score = checks.filter((c) => c.pass).length / checks.length;
    mkdirSync(join(outDir, String(iid)), { recursive: true });
    writeFileSync(join(outDir, String(iid), `${k}.json`), JSON.stringify({ output: res.data, checks, score, turns: res.turns, weighted: res.weighted, secs, over, strays }, null, 2));
    return { iid, n: k, score, checks, turns: res.turns, weighted: res.weighted, secs, over, stray: strays?.length ?? null, error: res.error };
  }));
  const samples = await pool(jobs, PARALLEL);

  // Per ticket: mean score, and which checks failed in how many samples.
  const rows = targets.map((iid) => {
    const mine = samples.filter((s) => s.iid === iid);
    const fails = new Map<string, number>();
    for (const s of mine) for (const c of s.checks) if (!c.pass) fails.set(c.name, (fails.get(c.name) ?? 0) + 1);
    return {
      iid,
      score: mine.reduce((a, s) => a + s.score, 0) / mine.length,
      turns: mine.reduce((a, s) => a + s.turns, 0) / mine.length,
      weighted: mine.reduce((a, s) => a + s.weighted, 0) / mine.length,
      secs: mine.reduce((a, s) => a + s.secs, 0) / mine.length,
      over: mine.filter((s) => s.over).length,
      stray: spec.stray ? mine.reduce((a, s) => a + (s.stray ?? 0), 0) / mine.length : null,
      live: liveCost(iid, phase),
      failed: [...fails].map(([c, k]) => `${c} ${k}/${mine.length}`).join(', '),
    };
  });
  const overall = rows.reduce((a, r) => a + r.score, 0) / rows.length;

  const previous = existsSync(join(EVALS, phase))
    ? readdirSync(join(EVALS, phase)).filter((d) => d < tag && existsSync(join(EVALS, phase, d, 'summary.json'))).sort().pop()
    : undefined;
  const prev = previous
    ? JSON.parse(readFileSync(join(EVALS, phase, previous, 'summary.json'), 'utf8')) as { overall: number; rows: Array<{ iid: number; weighted: number }> }
    : null;
  // A live baseline is not an eval of this checkout, so it never becomes `previous`.
  if (!liveOnly) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ phase, tag, n, overall, rows }, null, 2));
  }

  /** Signed percent change, or a dash when there is nothing to compare with. */
  const delta = (now: number, then: number | undefined): string =>
    then ? `${now >= then ? '+' : ''}${Math.round(((now - then) / then) * 100)}%` : '—';
  const sum = (xs: number[]): number => xs.reduce((a, x) => a + x, 0);

  console.log(`\n${phase} eval${liveOnly ? ' (live artifacts, no replay)' : ''} — ${targets.length} tickets × ${n} samples   ${outDir}\n`);
  console.log('ticket   score  turns  weighted  vs live  vs prev   secs  vs live  stray  over  failed checks');
  for (const r of rows) {
    console.log([
      `#${String(r.iid).padEnd(6)}`, r.score.toFixed(2).padStart(5),
      r.turns.toFixed(1).padStart(5), Math.round(r.weighted).toString().padStart(8),
      delta(r.weighted, r.live?.weighted).padStart(7),
      delta(r.weighted, prev?.rows.find((p) => p.iid === r.iid)?.weighted).padStart(7),
      Math.round(r.secs).toString().padStart(5), delta(r.secs, r.live?.secs).padStart(7),
      (r.stray === null ? '—' : r.stray.toFixed(1)).padStart(5), `${r.over}/${n}`.padStart(4), r.failed || '—',
    ].join('  '));
  }
  console.log('\nweighted = mean weighted tokens per sample (the config/budgets.json unit)');
  console.log(`vs live  = change against the live run's first ${phase} attempt; vs prev = against the last eval`);
  console.log(`secs     = mean wall clock per sample, ${PARALLEL} replays at a time, so it runs above a lone live run`);
  if (spec.stray) {
    console.log(spec.scoreCost
      ? 'stray    = mean tool calls outside the worktree or edits; scored as no-stray, with time and turns'
      : 'stray    = mean tool calls outside memory, reported and not scored');
  }
  console.log(`over     = samples past ${budget} weighted, ${cfg.maxTurns ?? '∞'} turns or the ${cfg.timeoutMin}m timeout`);
  const live = rows.filter((r) => r.live);
  console.log(`\noverall ${overall.toFixed(2)}   weighted ${Math.round(sum(rows.map((r) => r.weighted)))}`
    + (live.length ? `   vs live ${delta(sum(live.map((r) => r.weighted)), sum(live.map((r) => r.live!.weighted)))} over ${live.length} ticket(s)` : ''));
  if (prev) {
    console.log(`previous ${Number(prev.overall).toFixed(2)}  (${previous}) — only comparable if the tickets and n match`);
  }
}

main().catch((err: Error) => { console.error(err.message); process.exit(1); });
