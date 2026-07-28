import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { MaestroGraph } from '../graph/kg/engine.js';
import {
  buildKnowledgeUsageStats,
  type KnowledgeUsageStats,
} from '../graph/kg/knowledge-usage.js';
import { summarizeSessionKnowledge } from '../run/knowledge.js';
import { SessionStore } from '../run/store.js';
import { analyzeSpecHealth, type SpecHealthReport } from '../tools/spec-conflict-marker.js';
import { parseSpecEntries, type SpecEntryParsed } from '../tools/spec-entry-parser.js';
import { parseFrontmatter, knowhowFileToWikiId } from '../utils/frontmatter.js';
import { updateFileAtomic } from '../utils/atomic-write.js';
import { supersedeKnowhowEntry } from '../tools/knowhow-lifecycle.js';

export type KnowledgeAuditScope = 'spec' | 'knowhow' | 'all';

export interface KnowledgeAuditFinding {
  id: string;
  store: 'spec' | 'knowhow' | 'pipeline' | 'usage';
  priority: 'P0' | 'P1' | 'P2';
  subtype: string;
  target: string;
  evidence: string;
  recommended_action: 'observe' | 'review' | 'deprecate';
}

export type KnowledgePruneAction = {
  id: string;
  store: 'spec';
  action: 'deprecate';
  target_id: string;
  target_file: string;
  successor_id: string;
  successor_file: string;
  reason: 'unsynchronized-supersession' | 'exact-duplicate';
} | {
  id: string;
  store: 'knowhow';
  action: 'supersede';
  target_id: string;
  target_file: string;
  successor_id: string;
  successor_file: string;
  reason: 'exact-duplicate';
};

export interface KnowledgeAuditResult {
  schema_version: 'knowledge-audit/1.0';
  scope: KnowledgeAuditScope;
  generated_at: string;
  spec_health: SpecHealthReport | null;
  knowhow: {
    total: number;
    active: number;
    deprecated: number;
    invalid: number;
  } | null;
  usage: KnowledgeUsageStats | null;
  pipeline: {
    sessions: number;
    ledgers: number;
    pending_observed: number;
    pending_corroborated: number;
    promoted: number;
  };
  findings: KnowledgeAuditFinding[];
  prune_plan: KnowledgePruneAction[];
  applied: {
    count: number;
    backup_dir: string | null;
  };
  safety: {
    usage_only_never_pruned: true;
    physical_delete: false;
    apply_requires_prune: true;
  };
}

function conciseAuditError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.length <= 500) return message;
  try {
    const parsed = JSON.parse(message) as unknown;
    const issues: Array<{ path: string; message: string }> = [];
    const visit = (value: unknown): void => {
      if (issues.length >= 3 || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.message === 'string') {
        const path = Array.isArray(record.path)
          ? record.path.map(String).join('.')
          : '';
        issues.push({ path, message: record.message });
      }
      if (Array.isArray(record.errors)) visit(record.errors);
    };
    visit(parsed);
    if (issues.length > 0) {
      return issues
        .map(issue => `${issue.path || '<root>'}: ${issue.message}`)
        .join('; ');
    }
  } catch {
    // Non-JSON diagnostics fall back to a bounded raw message.
  }
  return `${message.slice(0, 497)}...`;
}

interface ProjectSpec {
  filePath: string;
  fileLabel: string;
  entry: SpecEntryParsed;
}

interface ProjectKnowhow {
  id: string;
  filePath: string;
  fileLabel: string;
  title: string;
  body: string;
  active: boolean;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 10)}`;
}

function splitSids(value?: string): string[] {
  return value?.split(',').map(item => item.trim()).filter(Boolean) ?? [];
}

function projectSpecs(projectRoot: string): ProjectSpec[] {
  const dir = join(projectRoot, '.workflow', 'specs');
  if (!existsSync(dir)) return [];
  const specs: ProjectSpec[] = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.md')).sort()) {
    const filePath = join(dir, file);
    const { entries } = parseSpecEntries(readFileSync(filePath, 'utf8'));
    for (const entry of entries) specs.push({ filePath, fileLabel: file, entry });
  }
  return specs;
}

function inspectKnowhow(projectRoot: string): {
  summary: NonNullable<KnowledgeAuditResult['knowhow']>;
  findings: KnowledgeAuditFinding[];
  documents: ProjectKnowhow[];
} {
  const dir = join(projectRoot, '.workflow', 'knowhow');
  const summary = { total: 0, active: 0, deprecated: 0, invalid: 0 };
  const findings: KnowledgeAuditFinding[] = [];
  const documents: ProjectKnowhow[] = [];
  if (!existsSync(dir)) return { summary, findings, documents };
  for (const file of readdirSync(dir).filter(name => name.endsWith('.md')).sort()) {
    summary.total++;
    try {
      const filePath = join(dir, file);
      const { data, body } = parseFrontmatter(readFileSync(filePath, 'utf8'));
      const status = typeof data.status === 'string' ? normalized(data.status) : 'active';
      const active = status !== 'deprecated' && status !== 'superseded';
      if (active) summary.active++;
      else summary.deprecated++;
      documents.push({
        id: knowhowFileToWikiId(file),
        filePath,
        fileLabel: file,
        title: typeof data.title === 'string' ? data.title : '',
        body: body.trim(),
        active,
      });
      if (!data.title || !data.type) {
        summary.invalid++;
        findings.push({
          id: stableId('KAU', 'knowhow-metadata', file),
          store: 'knowhow',
          priority: 'P1',
          subtype: 'missing-required-metadata',
          target: knowhowFileToWikiId(file),
          evidence: `${file} is missing title or type frontmatter`,
          recommended_action: 'review',
        });
      }
      const codePaths = Array.isArray(data.codePaths) ? data.codePaths : [];
      for (const codePath of codePaths.filter((item): item is string => typeof item === 'string')) {
        const target = resolve(projectRoot, codePath);
        const withinProject = relative(projectRoot, target).split(/[\\/]/)[0] !== '..';
        if (withinProject && !existsSync(target)) {
          findings.push({
            id: stableId('KAU', 'ghost-code-ref', file, codePath),
            store: 'knowhow',
            priority: 'P1',
            subtype: 'ghost-code-reference',
            target: knowhowFileToWikiId(file),
            evidence: `Missing code path: ${codePath}`,
            recommended_action: 'review',
          });
        }
      }
    } catch (error) {
      summary.invalid++;
      findings.push({
        id: stableId('KAU', 'knowhow-parse', file),
        store: 'knowhow',
        priority: 'P1',
        subtype: 'invalid-frontmatter',
        target: file,
        evidence: conciseAuditError(error),
        recommended_action: 'review',
      });
    }
  }
  return { summary, findings, documents };
}

function inspectPipeline(projectRoot: string): {
  summary: KnowledgeAuditResult['pipeline'];
  findings: KnowledgeAuditFinding[];
} {
  const summary = {
    sessions: 0,
    ledgers: 0,
    pending_observed: 0,
    pending_corroborated: 0,
    promoted: 0,
  };
  const findings: KnowledgeAuditFinding[] = [];
  const sessionsRoot = join(projectRoot, '.workflow', 'sessions');
  if (!existsSync(sessionsRoot)) return { summary, findings };
  const store = new SessionStore(projectRoot);
  const listed = store.listSessionsReadOnly();
  const sessions = listed.candidates;
  summary.sessions = sessions.length + listed.exclusions.length;
  for (const exclusion of listed.exclusions) {
    findings.push({
      id: stableId('KAU', 'session-corrupt', exclusion.sessionId, exclusion.detail),
      store: 'pipeline',
      priority: 'P1',
      subtype: 'invalid-session-authority',
      target: exclusion.sessionId,
      evidence: `${exclusion.code}: ${exclusion.detail}`,
      recommended_action: 'review',
    });
  }
  for (const session of sessions) {
    try {
      const knowledge = summarizeSessionKnowledge(projectRoot, session.sessionId, {
        readOnly: true,
        strict: true,
      });
      summary.ledgers += knowledge.ledger_count;
      for (const candidate of knowledge.candidates) {
        if (candidate.status === 'promoted') summary.promoted++;
        else if ((candidate.status === 'pending' || candidate.status === 'promoting')
          && candidate.stage === 'corroborated') {
          summary.pending_corroborated++;
        } else if (candidate.status === 'pending' || candidate.status === 'promoting') {
          summary.pending_observed++;
        }
      }
    } catch (error) {
      findings.push({
        id: stableId('KAU', 'ledger-corrupt', session.sessionId),
        store: 'pipeline',
        priority: 'P1',
        subtype: 'invalid-knowledge-ledger',
        target: session.sessionId,
        evidence: conciseAuditError(error),
        recommended_action: 'review',
      });
    }
  }
  if (summary.pending_corroborated > 0) {
    findings.push({
      id: stableId('KAU', 'promotion-backlog', String(summary.pending_corroborated)),
      store: 'pipeline',
      priority: 'P2',
      subtype: 'corroborated-promotion-backlog',
      target: 'session-knowledge',
      evidence: `${summary.pending_corroborated} corroborated candidate(s) await explicit promotion`,
      recommended_action: 'review',
    });
  }
  return { summary, findings };
}

function buildSpecFindings(
  specs: ProjectSpec[],
  health: SpecHealthReport,
): { findings: KnowledgeAuditFinding[]; plan: KnowledgePruneAction[] } {
  const findings: KnowledgeAuditFinding[] = [];
  const plan: KnowledgePruneAction[] = [];
  const bySid = new Map(specs.flatMap(spec => spec.entry.sid ? [[spec.entry.sid, spec] as const] : []));
  const successor = new Map<string, string>();
  for (const spec of specs) {
    if (!spec.entry.sid) {
      findings.push({
        id: stableId('KAU', 'missing-sid', spec.fileLabel, String(spec.entry.lineStart)),
        store: 'spec',
        priority: 'P2',
        subtype: 'missing-stable-id',
        target: `${spec.fileLabel}:${spec.entry.lineStart}`,
        evidence: `Active lifecycle operations cannot safely target "${spec.entry.title}"`,
        recommended_action: 'review',
      });
      continue;
    }
    for (const oldSid of splitSids(spec.entry.supersedes)) successor.set(oldSid, spec.entry.sid);
  }

  for (const spec of specs) {
    const sid = spec.entry.sid;
    if (!sid || spec.entry.status === 'deprecated') continue;
    const successorId = spec.entry.supersededBy ?? successor.get(sid);
    if (!successorId || !bySid.has(successorId)) continue;
    const findingId = stableId('KAU', 'unsynced-supersession', sid, successorId);
    findings.push({
      id: findingId,
      store: 'spec',
      priority: 'P1',
      subtype: 'unsynchronized-supersession',
      target: sid,
      evidence: `${sid} is superseded by ${successorId} but remains active`,
      recommended_action: 'deprecate',
    });
    plan.push({
      id: stableId('KPA', sid, successorId),
      store: 'spec',
      action: 'deprecate',
      target_id: sid,
      target_file: spec.filePath,
      successor_id: successorId,
      successor_file: bySid.get(successorId)!.filePath,
      reason: 'unsynchronized-supersession',
    });
  }

  const plannedTargets = new Set(plan.map(action => action.target_id));
  const duplicateGroups = new Map<string, ProjectSpec[]>();
  for (const spec of specs) {
    if (!spec.entry.sid || spec.entry.status === 'deprecated') continue;
    const key = `${normalized(spec.entry.title)}\0${normalized(spec.entry.content)}`;
    const group = duplicateGroups.get(key) ?? [];
    group.push(spec);
    duplicateGroups.set(key, group);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    const ordered = group.sort((left, right) => left.entry.sid!.localeCompare(right.entry.sid!));
    const canonical = ordered[0];
    for (const duplicate of ordered.slice(1)) {
      const targetId = duplicate.entry.sid!;
      if (plannedTargets.has(targetId)) continue;
      plannedTargets.add(targetId);
      findings.push({
        id: stableId('KAU', 'spec-exact-duplicate', targetId, canonical.entry.sid!),
        store: 'spec',
        priority: 'P1',
        subtype: 'exact-duplicate',
        target: targetId,
        evidence: `${targetId} duplicates canonical ${canonical.entry.sid!}`,
        recommended_action: 'deprecate',
      });
      plan.push({
        id: stableId('KPA', 'spec-exact-duplicate', targetId, canonical.entry.sid!),
        store: 'spec',
        action: 'deprecate',
        target_id: targetId,
        target_file: duplicate.filePath,
        successor_id: canonical.entry.sid!,
        successor_file: canonical.filePath,
        reason: 'exact-duplicate',
      });
    }
  }

  for (const item of health.danglingSupersedes) {
    findings.push({
      id: stableId('KAU', 'dangling-supersedes', item.sid, item.target),
      store: 'spec',
      priority: 'P0',
      subtype: 'dangling-supersedes',
      target: item.sid,
      evidence: `References missing predecessor ${item.target}`,
      recommended_action: 'review',
    });
  }
  for (const item of health.danglingSupersededBy) {
    findings.push({
      id: stableId('KAU', 'dangling-successor', item.sid, item.target),
      store: 'spec',
      priority: 'P0',
      subtype: 'dangling-superseded-by',
      target: item.sid,
      evidence: `References missing successor ${item.target}`,
      recommended_action: 'review',
    });
  }
  for (const sid of health.cyclicSids) {
    findings.push({
      id: stableId('KAU', 'cycle', sid),
      store: 'spec',
      priority: 'P0',
      subtype: 'supersession-cycle',
      target: sid,
      evidence: `${sid} participates in a supersession cycle`,
      recommended_action: 'review',
    });
  }
  if (health.staleActive > 0) {
    findings.push({
      id: stableId('KAU', 'stale-active', String(health.staleActive)),
      store: 'spec',
      priority: 'P2',
      subtype: 'stale-active-observation',
      target: 'spec-store',
      evidence: `${health.staleActive} active entries have freshness below 0.5`,
      recommended_action: 'observe',
    });
  }
  return { findings, plan };
}

function buildKnowhowDuplicateFindings(
  documents: ProjectKnowhow[],
): { findings: KnowledgeAuditFinding[]; plan: KnowledgePruneAction[] } {
  const findings: KnowledgeAuditFinding[] = [];
  const plan: KnowledgePruneAction[] = [];
  const groups = new Map<string, ProjectKnowhow[]>();
  for (const document of documents.filter(item => item.active && item.title && item.body)) {
    const key = `${normalized(document.title)}\0${normalized(document.body)}`;
    const group = groups.get(key) ?? [];
    group.push(document);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = group.sort((left, right) => left.id.localeCompare(right.id));
    const canonical = ordered[0];
    for (const duplicate of ordered.slice(1)) {
      findings.push({
        id: stableId('KAU', 'knowhow-exact-duplicate', duplicate.id, canonical.id),
        store: 'knowhow',
        priority: 'P1',
        subtype: 'exact-duplicate',
        target: duplicate.id,
        evidence: `${duplicate.id} duplicates canonical ${canonical.id}`,
        recommended_action: 'deprecate',
      });
      plan.push({
        id: stableId('KPA', 'knowhow-exact-duplicate', duplicate.id, canonical.id),
        store: 'knowhow',
        action: 'supersede',
        target_id: duplicate.id,
        target_file: duplicate.filePath,
        successor_id: canonical.id,
        successor_file: canonical.filePath,
        reason: 'exact-duplicate',
      });
    }
  }
  return { findings, plan };
}

function addUsageFinding(usage: KnowledgeUsageStats, findings: KnowledgeAuditFinding[]): void {
  const exposure = usage.impressionConcentration;
  if (exposure.totalEvents > 0 && (exposure.top10Share > 0.75 || exposure.gini > 0.65)) {
    findings.push({
      id: stableId('KAU', 'usage-concentration', String(exposure.totalEvents), exposure.gini.toFixed(6)),
      store: 'usage',
      priority: 'P2',
      subtype: 'exposure-concentration',
      target: 'knowledge-search',
      evidence: `Top-10 share ${(exposure.top10Share * 100).toFixed(1)}%, Gini ${exposure.gini.toFixed(3)}`,
      recommended_action: 'observe',
    });
  }
}

function deprecateSpecAction(action: Extract<KnowledgePruneAction, { store: 'spec' }>): void {
  let found = false;
  updateFileAtomic(action.target_file, current => {
    if (current === null) throw new Error(`Missing spec file: ${action.target_file}`);
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const lines = current.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.includes('<spec-entry') || !line.includes(`sid="${action.target_id}"`)) continue;
      found = true;
      let updated = line;
      if (/\sstatus="[^"]*"/.test(updated)) {
        updated = updated.replace(/\sstatus="[^"]*"/, ' status="deprecated"');
      } else {
        updated = updated.replace(/>\s*$/, ' status="deprecated">');
      }
      if (/\ssuperseded-by="[^"]*"/.test(updated)) {
        updated = updated.replace(
          /\ssuperseded-by="[^"]*"/,
          ` superseded-by="${action.successor_id}"`,
        );
      } else {
        updated = updated.replace(/>\s*$/, ` superseded-by="${action.successor_id}">`);
      }
      lines[index] = updated;
      break;
    }
    if (!found) throw new Error(`Spec sid not found: ${action.target_id}`);
    return lines.join(eol);
  });
}

function applyPrunePlan(
  projectRoot: string,
  plan: KnowledgePruneAction[],
): KnowledgeAuditResult['applied'] {
  if (plan.length === 0) return { count: 0, backup_dir: null };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(projectRoot, '.workflow', '.trash', `knowledge-audit-${stamp}`);
  const uniqueFiles = [...new Set(plan.flatMap(action => [
    action.target_file,
    action.successor_file,
  ]))];
  for (const file of uniqueFiles) {
    const destination = join(backupDir, relative(projectRoot, file));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file, destination);
  }
  try {
    for (const action of plan) {
      if (action.store === 'spec') {
        deprecateSpecAction(action);
      } else {
        const result = supersedeKnowhowEntry(
          projectRoot,
          action.target_id,
          action.successor_id,
        );
        if (!result.success) throw new Error(result.error ?? `Failed to supersede ${action.target_id}`);
      }
    }

    const logDir = join(projectRoot, '.workflow', '.knowledge-audit');
    mkdirSync(logDir, { recursive: true });
    const appliedAt = new Date().toISOString();
    const logPath = join(logDir, 'audit-log.jsonl');
    const records = plan.map(action => JSON.stringify({
      audit_id: stableId('AUD', appliedAt, action.id),
      action_id: action.id,
      store: action.store,
      target_id: action.target_id,
      action: action.action,
      reason: action.reason,
      applied_at: appliedAt,
      backup_path: relative(projectRoot, backupDir).replaceAll('\\', '/'),
    })).join('\n') + '\n';
    updateFileAtomic(logPath, current => (current ?? '') + records);
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const file of uniqueFiles) {
      const backup = join(backupDir, relative(projectRoot, file));
      try {
        updateFileAtomic(file, () => readFileSync(backup, 'utf8'));
      } catch (rollbackError) {
        rollbackErrors.push(
          `${file}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Knowledge prune failed and rollback was incomplete: ${rollbackErrors.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    count: plan.length,
    backup_dir: relative(projectRoot, backupDir).replaceAll('\\', '/'),
  };
}

export async function auditKnowledge(
  projectRootInput: string,
  options: { scope?: KnowledgeAuditScope; prune?: boolean; apply?: boolean } = {},
): Promise<KnowledgeAuditResult> {
  const projectRoot = resolve(projectRootInput);
  const scope = options.scope ?? 'all';
  if (options.apply && !options.prune) throw new Error('--apply requires --prune');

  const findings: KnowledgeAuditFinding[] = [];
  let specHealth: SpecHealthReport | null = null;
  let prunePlan: KnowledgePruneAction[] = [];
  if (scope === 'spec' || scope === 'all') {
    specHealth = analyzeSpecHealth(projectRoot);
    const spec = buildSpecFindings(projectSpecs(projectRoot), specHealth);
    findings.push(...spec.findings);
    prunePlan = spec.plan;
  }

  let knowhow: KnowledgeAuditResult['knowhow'] = null;
  if (scope === 'knowhow' || scope === 'all') {
    const inspected = inspectKnowhow(projectRoot);
    knowhow = inspected.summary;
    findings.push(...inspected.findings);
    const duplicates = buildKnowhowDuplicateFindings(inspected.documents);
    findings.push(...duplicates.findings);
    prunePlan.push(...duplicates.plan);
  }

  let usage: KnowledgeUsageStats | null = null;
  if (MaestroGraph.isInitialized(projectRoot)) {
    const graph = await MaestroGraph.openReadOnly(projectRoot);
    try {
      usage = buildKnowledgeUsageStats(graph.rawDb, null, 10);
      addUsageFinding(usage, findings);
    } finally {
      graph.close();
    }
  }

  const pipeline = inspectPipeline(projectRoot);
  findings.push(...pipeline.findings);
  findings.sort((left, right) =>
    left.priority.localeCompare(right.priority)
    || left.store.localeCompare(right.store)
    || normalized(left.target).localeCompare(normalized(right.target))
    || left.id.localeCompare(right.id)
  );
  prunePlan.sort((left, right) => left.target_id.localeCompare(right.target_id));
  const applied = options.apply ? applyPrunePlan(projectRoot, prunePlan) : { count: 0, backup_dir: null };

  return {
    schema_version: 'knowledge-audit/1.0',
    scope,
    generated_at: new Date().toISOString(),
    spec_health: specHealth,
    knowhow,
    usage,
    pipeline: pipeline.summary,
    findings,
    prune_plan: options.prune ? prunePlan : [],
    applied,
    safety: {
      usage_only_never_pruned: true,
      physical_delete: false,
      apply_requires_prune: true,
    },
  };
}
