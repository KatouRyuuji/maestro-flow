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
  started_at: string | null;
  completed_at: string | null;
}

export interface MaestroSessionSummary {
  session_id: string;
  intent: string | null;
  status: string;
  active_run_id: string | null;
  latest_completed_run_id: string | null;
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

/** Parse run.json into a summary. */
function parseRun(raw: Record<string, unknown>): MaestroRunSummary {
  const output = asRecord(raw.output);
  const handoff = asRecord(raw.handoff);
  const command = asRecord(raw.command);
  return {
    run_id: asString(raw.run_id) ?? '?',
    sequence: typeof raw.sequence === 'number' ? raw.sequence : null,
    status: asString(raw.status) ?? 'unknown',
    verdict: asString(output?.verdict) ?? asString(handoff?.verdict),
    command: asString(command?.name) ?? asString(raw.command as unknown),
    platform: asString(raw.resolved_platform),
    started_at: asString(raw.started_at),
    completed_at: asString(raw.completed_at) ?? asString(raw.sealed_at),
  };
}

/** Load the most recent run.json inside a session's runs/ directory. */
async function loadLatestRun(sessionDir: string): Promise<{
  run: MaestroRunSummary | null;
  runCount: number;
}> {
  const runsDir = join(sessionDir, 'runs');
  const runDirs = await safeListDirs(runsDir);
  if (runDirs.length === 0) return { run: null, runCount: 0 };

  // Runs are sorted by run_id sequence (YYYYMMDD-NNN-name); pick the last.
  runDirs.sort((a, b) => a.localeCompare(b));
  const latestDir = runDirs[runDirs.length - 1];
  const raw = await safeReadJson(join(runsDir, latestDir, 'run.json'));
  return {
    run: raw ? parseRun(raw) : null,
    runCount: runDirs.length,
  };
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
  let cache: { at: number; body: MaestroStatusResponse } | null = null;
  const CACHE_TTL_MS = 5000;

  // GET /api/maestro-status — project + sessions + knowledge overview
  app.get('/api/maestro-status', async (c) => {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
      return c.json(cache.body);
    }

    const root = getRoot();

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

    // Cap the list — newest first, at most 40 sessions.
    candidates.sort((a, b) => b.id.localeCompare(a.id));
    const capped = candidates.slice(0, 40);

    for (const cand of capped) {
      const sessionDir = join(sessionsDir, cand.id);
      const hasDir = sessionDirSet.has(cand.id);

      let activeRunId: string | null = null;
      let latestCompletedRunId: string | null = null;
      let sessionStatus = cand.status;
      if (hasDir) {
        const sessionJson = await safeReadJson(join(sessionDir, 'session.json'));
        if (sessionJson) {
          activeRunId = asString(sessionJson.active_run_id);
          latestCompletedRunId = asString(sessionJson.latest_completed_run_id);
          if (!sessionStatus) sessionStatus = asString(sessionJson.status);
        }
        const { run, runCount } = await loadLatestRun(sessionDir);
        sessions.push({
          session_id: cand.id,
          intent: cand.intent ?? null,
          status: sessionStatus ?? 'unknown',
          active_run_id: activeRunId,
          latest_completed_run_id: latestCompletedRunId,
          run_count: runCount,
          latest_run: run,
        });
      } else {
        sessions.push({
          session_id: cand.id,
          intent: cand.intent ?? null,
          status: sessionStatus ?? 'unknown',
          active_run_id: activeRunId,
          latest_completed_run_id: latestCompletedRunId,
          run_count: 0,
          latest_run: null,
        });
      }
    }

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
        total: specs + memory + knowhow + learningRows,
      },
      generated_at: new Date().toISOString(),
    };

    cache = { at: now, body };
    return c.json(body);
  });

  // GET /api/maestro-status/runs?session=<id> — run details for one session
  app.get('/api/maestro-status/runs', async (c) => {
    const sessionId = c.req.query('session');
    if (!sessionId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sessionId)) {
      return c.json({ error: 'Missing or invalid "session" query' }, 400);
    }

    const sessionDir = join(getRoot(), 'sessions', sessionId);
    const runDirs = await safeListDirs(join(sessionDir, 'runs'));
    runDirs.sort((a, b) => a.localeCompare(b));

    const runs: MaestroRunSummary[] = [];
    for (const dir of runDirs) {
      const raw = await safeReadJson(join(sessionDir, 'runs', dir, 'run.json'));
      if (raw) runs.push(parseRun(raw));
    }

    return c.json({ session_id: sessionId, runs });
  });

  return app;
}
