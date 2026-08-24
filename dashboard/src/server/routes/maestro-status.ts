// ---------------------------------------------------------------------------
// Maestro Status routes — Session/Run 架构状态 + 知识积累统计
//
// Reads .workflow/state.json (session registry) plus per-session
// session.json / runs/<run-id>/run.json to expose the Session→Run chain
// as a lightweight overview for the Desktop Sidebar. Also counts knowledge
// accumulation (specs / memory / knowhow / learning / issues).
//
// GET /api/maestro-status                    - project + sessions + knowledge
// GET /api/maestro-status/runs?session=<id>  - run details for one session
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaestroRunSummary {
  run_id: string;
  sequence: number | null;
  status: string;
  verdict: string | null;
  command: string | null;
  platform: string | null;
  actor_id: string | null;
  summary: string | null;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  completed_at: string | null;
}

export interface MaestroSessionSummary {
  session_id: string;
  intent: string | null;
  status: string;
  active_run_ids: string[];
  active_run_id: string | null;
  latest_completed_run_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  run_count: number;
  latest_run: MaestroRunSummary | null;
}

export interface MaestroStatusResponse {
  project: {
    project_name: string | null;
    status: string | null;
    active_session_id: string | null;
    last_updated: string | null;
  };
  sessions: MaestroSessionSummary[];
  knowledge: {
    specs: number;
    memory: number;
    knowhow: number;
    learning_rows: number;
    issue_rows: number;
    total: number;
  };
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read + parse JSON, returning null on any failure (missing/corrupt). */
async function safeReadJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** List subdirectory names; empty on failure. */
async function safeListDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Count *.md files in a directory (non-recursive). */
async function countMdFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/** Count JSONL rows across *.jsonl files in a directory. */
async function countJsonlRows(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    let rows = 0;
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const raw = await readFile(join(dir, f), 'utf-8');
        rows += raw.split('\n').filter((l) => l.trim().length > 0).length;
      } catch {
        // skip unreadable file
      }
    }
    return rows;
  } catch {
    return 0;
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(asString).filter((item): item is string => item !== null))];
}

/** Parse run.json into a backwards-compatible summary. */
function parseRun(raw: Record<string, unknown>, fallbackRunId: string): MaestroRunSummary {
  const output = asRecord(raw.output);
  const handoff = asRecord(raw.handoff);
  const command = asRecord(raw.command);
  const endedAt = asString(raw.ended_at)
    ?? asString(raw.completed_at)
    ?? asString(raw.sealed_at);
  return {
    run_id: asString(raw.run_id) ?? fallbackRunId,
    sequence: typeof raw.sequence === 'number' ? raw.sequence : null,
    status: asString(raw.status) ?? 'unknown',
    verdict: asString(raw.verdict)
      ?? asString(output?.verdict)
      ?? asString(handoff?.verdict),
    command: asString(raw.command) ?? asString(command?.name),
    platform: asString(raw.resolved_platform),
    actor_id: asString(raw.actor_id),
    summary: asString(raw.summary) ?? asString(handoff?.summary),
    created_at: asString(raw.created_at),
    started_at: asString(raw.started_at),
    ended_at: endedAt,
    completed_at: asString(raw.completed_at)
      ?? asString(raw.ended_at)
      ?? asString(raw.sealed_at),
  };
}

function runTimestamp(run: MaestroRunSummary): number | null {
  for (const value of [run.created_at, run.started_at, run.ended_at, run.completed_at]) {
    if (value === null) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

/** Chronological order with stable behavior for missing/equal timestamps. */
function compareRuns(left: MaestroRunSummary, right: MaestroRunSummary): number {
  const leftTimestamp = runTimestamp(left);
  const rightTimestamp = runTimestamp(right);
  if (leftTimestamp !== rightTimestamp) {
    if (leftTimestamp === null) return -1;
    if (rightTimestamp === null) return 1;
    return leftTimestamp - rightTimestamp;
  }
  return left.run_id.localeCompare(right.run_id);
}

function isCompletedRun(run: MaestroRunSummary): boolean {
  return run.status === 'completed' || run.status === 'sealed';
}

function completionTimestamp(run: MaestroRunSummary): number | null {
  for (const value of [run.ended_at, run.completed_at, run.started_at, run.created_at]) {
    if (value === null) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function latestCompletedRun(runs: MaestroRunSummary[]): MaestroRunSummary | null {
  return runs
    .filter(isCompletedRun)
    .sort((left, right) => {
      const leftTimestamp = completionTimestamp(left);
      const rightTimestamp = completionTimestamp(right);
      if (leftTimestamp !== rightTimestamp) {
        if (leftTimestamp === null) return -1;
        if (rightTimestamp === null) return 1;
        return leftTimestamp - rightTimestamp;
      }
      return left.run_id.localeCompare(right.run_id);
    })
    .at(-1) ?? null;
}

function sessionTimestamp(session: MaestroSessionSummary): number | null {
  for (const value of [session.updated_at, session.created_at]) {
    if (value === null) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return session.latest_run ? runTimestamp(session.latest_run) : null;
}

function sessionStatusRank(session: MaestroSessionSummary, activeSessionId: string | null): number {
  if (session.session_id === activeSessionId || session.active_run_ids.length > 0) return 0;
  if (session.status === 'open' || session.status === 'running' || session.status === 'active') return 1;
  if (session.status === 'failed' || session.status === 'blocked') return 2;
  return 3;
}

/** Load and chronologically sort readable run.json files inside a session. */
async function loadRuns(sessionDir: string): Promise<{
  runs: MaestroRunSummary[];
  runCount: number;
}> {
  const runsDir = join(sessionDir, 'runs');
  const runDirs = await safeListDirs(runsDir);
  const runs: MaestroRunSummary[] = [];

  // Directory order is not lifecycle order for canonical hash-based Run IDs.
  for (const runDir of runDirs.sort((a, b) => a.localeCompare(b))) {
    const raw = await safeReadJson(join(runsDir, runDir, 'run.json'));
    if (raw) runs.push(parseRun(raw, runDir));
  }
  runs.sort(compareRuns);
  return { runs, runCount: runDirs.length };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createMaestroStatusRoutes(
  workflowRoot: string | (() => string),
): Hono {
  const app = new Hono();
  const getRoot = () =>
    typeof workflowRoot === 'function' ? workflowRoot() : workflowRoot;

  // 5s in-memory cache — the sidebar polls anyway, this just guards bursts.
  let cache: { root: string; at: number; body: MaestroStatusResponse } | null = null;
  const CACHE_TTL_MS = 5000;

  // GET /api/maestro-status — project + sessions + knowledge overview
  app.get('/api/maestro-status', async (c) => {
    const root = getRoot();
    const now = Date.now();
    if (cache && cache.root === root && now - cache.at < CACHE_TTL_MS) {
      return c.json(cache.body);
    }

    // ── project + session registry from state.json ──────────────────────
    const state = await safeReadJson(join(root, 'state.json'));
    const registry = Array.isArray(state?.sessions) ? state.sessions : [];
    const project = {
      project_name: asString(state?.project_name),
      status: asString(state?.status),
      active_session_id: asString(state?.active_session_id),
      last_updated: asString(state?.last_updated),
    };

    // ── per-session detail from sessions/<id>/ ──────────────────────────
    const sessionsDir = join(root, 'sessions');
    const sessionDirs = await safeListDirs(sessionsDir);
    const sessionDirSet = new Set(sessionDirs);

    const sessions: MaestroSessionSummary[] = [];
    const seen = new Set<string>();

    // Merge registry order with on-disk detail; registry entries missing a
    // dir still surface (status from registry), dirs not in registry too.
    const candidates: Array<{ id: string; intent: string | null; status: string | null }> = [];
    for (const s of registry) {
      const rec = asRecord(s);
      const id = asString(rec?.session_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      candidates.push({
        id,
        intent: asString(rec?.intent),
        status: asString(rec?.status),
      });
    }
    for (const dir of sessionDirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      candidates.push({ id: dir, intent: null, status: null });
    }

    // Keep candidate order deterministic; lifecycle ordering and the 40-row
    // cap are applied only after each Session's canonical timestamps are read.
    candidates.sort((a, b) => a.id.localeCompare(b.id));

    for (const cand of candidates) {
      const sessionDir = join(sessionsDir, cand.id);
      const hasDir = sessionDirSet.has(cand.id);

      let activeRunIds: string[] = [];
      let activeRunId: string | null = null;
      let latestCompletedRunId: string | null = null;
      let sessionStatus = cand.status;
      let sessionIntent = cand.intent;
      let sessionCreatedAt: string | null = null;
      let sessionUpdatedAt: string | null = null;
      if (hasDir) {
        const sessionJson = await safeReadJson(join(sessionDir, 'session.json'));
        if (sessionJson) {
          const isV3 = asString(sessionJson.schema_version) === 'session/3.0';
          const singularActiveRunId = asString(sessionJson.active_run_id);
          activeRunIds = asStringArray(sessionJson.active_run_ids);
          if (activeRunIds.length === 0 && singularActiveRunId) {
            activeRunIds = [singularActiveRunId];
          }
          activeRunId = singularActiveRunId;
          latestCompletedRunId = asString(sessionJson.latest_completed_run_id);
          sessionCreatedAt = asString(sessionJson.created_at);
          sessionUpdatedAt = asString(sessionJson.updated_at);
          if (isV3) {
            sessionIntent = asString(sessionJson.objective) ?? asString(sessionJson.intent) ?? cand.intent;
            sessionStatus = asString(sessionJson.status) ?? cand.status;
          } else {
            sessionIntent = asString(sessionJson.intent) ?? cand.intent;
            sessionStatus = asString(sessionJson.status) ?? cand.status;
          }
        }
        const { runs, runCount } = await loadRuns(sessionDir);
        const latestRun = runs.at(-1) ?? null;
        activeRunId = activeRunId
          ?? runs.filter((run) => activeRunIds.includes(run.run_id)).at(-1)?.run_id
          ?? null;
        latestCompletedRunId = latestCompletedRunId
          ?? latestCompletedRun(runs)?.run_id
          ?? null;
        sessions.push({
          session_id: cand.id,
          intent: sessionIntent,
          status: sessionStatus ?? 'unknown',
          active_run_ids: activeRunIds,
          active_run_id: activeRunId,
          latest_completed_run_id: latestCompletedRunId,
          created_at: sessionCreatedAt,
          updated_at: sessionUpdatedAt,
          run_count: runCount,
          latest_run: latestRun,
        });
      } else {
        sessions.push({
          session_id: cand.id,
          intent: sessionIntent,
          status: sessionStatus ?? 'unknown',
          active_run_ids: activeRunIds,
          active_run_id: activeRunId,
          latest_completed_run_id: latestCompletedRunId,
          created_at: sessionCreatedAt,
          updated_at: sessionUpdatedAt,
          run_count: 0,
          latest_run: null,
        });
      }
    }

    sessions.sort((left, right) => {
      const rank = sessionStatusRank(left, project.active_session_id)
        - sessionStatusRank(right, project.active_session_id);
      if (rank !== 0) return rank;
      const leftTimestamp = sessionTimestamp(left);
      const rightTimestamp = sessionTimestamp(right);
      if (leftTimestamp !== rightTimestamp) {
        if (leftTimestamp === null) return 1;
        if (rightTimestamp === null) return -1;
        return rightTimestamp - leftTimestamp;
      }
      return right.session_id.localeCompare(left.session_id);
    });
    sessions.splice(40);

    // ── knowledge accumulation counters ─────────────────────────────────
    const [specs, memory, knowhow, learningRows, issueRows] = await Promise.all([
      countMdFiles(join(root, 'specs')),
      countMdFiles(join(root, 'memory')),
      countMdFiles(join(root, 'knowhow')),
      countJsonlRows(join(root, 'learning')),
      countJsonlRows(join(root, 'issues')),
    ]);

    const body: MaestroStatusResponse = {
      project,
      sessions,
      knowledge: {
        specs,
        memory,
        knowhow,
        learning_rows: learningRows,
        issue_rows: issueRows,
        total: specs + memory + knowhow + learningRows + issueRows,
      },
      generated_at: new Date().toISOString(),
    };

    cache = { root, at: Date.now(), body };
    return c.json(body);
  });

  // GET /api/maestro-status/runs?session=<id> — run details for one session
  app.get('/api/maestro-status/runs', async (c) => {
    const sessionId = c.req.query('session');
    if (!sessionId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sessionId)) {
      return c.json({ error: 'Missing or invalid "session" query' }, 400);
    }

    const sessionDir = join(getRoot(), 'sessions', sessionId);
    const { runs } = await loadRuns(sessionDir);

    return c.json({ session_id: sessionId, runs });
  });

  return app;
}
