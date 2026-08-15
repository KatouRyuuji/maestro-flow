import { readFileSync } from 'node:fs';

const LEGACY_HEADING = /^## Legacy `session\/1\.x(?:\/2\.x)?` Compatibility Branch\s*$/m;

function canonicalBranch(text) {
  const match = LEGACY_HEADING.exec(text);
  return match ? text.slice(0, match.index) : text;
}

const docs = [
  'workflows/run-mode.md',
  'workflows/run-mode-lite.md',
  'workflows/orchestrator-run-loop.md',
  'prepare/ralph.md',
];

const tokens = [
  'maestro capabilities --json',
  'session/3.0', 'run/3.0', 'run-response/1.2', 'orchestration_revision',
  'session open', 'session complete', 'session status', 'session list', 'resume-view',
  'session chain insert', 'session chain replace', 'session chain skip',
  'session chain insert|replace|skip', 'session chain',
  'run create', 'run next', 'run brief', 'run check', 'run complete', 'run decide',
  'run cancel', 'run transition', 'run recall', 'run seal',
  'run complete --advance', '--advance',
  'run_already_created', 'brief-result/3.0',
  '--participant', '--actor', '--request-id', '--reason', '--evidence',
  '--expected-orchestration-revision', '--expected-run-revision',
  '--json', '--verdict', '--confidence', '--after-step', '--step-id',
  '--definition-of-done', '--chain', '--goal-ref', '--stage', '--decision-ref',
  '--id', '--run', '--step', '--goal', '--input', '--arg',
  'no lease', 'no paused', '无 lease', '无 paused',
  'candidate_version', 'content_hash', 'evidence_roots', 'evidence_root_hash',
  'candidate_snapshot_hash', 'corpus_fingerprint',
  'does **not** require Session completion', 'does not require Session completion',
  'execution-seal', 'post-execution',
  'owning the chain', 'Session-owned', 'only authority for chain',
  'artifact inspect', 'artifact republish', 'artifact-inspect', 'artifact-republish',
  'session migrate', 'session archive', 'session unarchive',
  'entity_revision_cas', 'participant_identity', 'request_receipts_v2',
  'session_run_minimal_v3', 'execution_lease=false', 'operation_registry=false',
  'maestro knowledge stage', 'maestro knowledge review', 'maestro knowledge promote',
  'knowledge_context', 'knowledge-candidate-receipt/1.0',
];

for (const doc of docs) {
  const text = readFileSync(doc, 'utf8');
  const canonical = canonicalBranch(text);
  const missing = tokens.filter(t => !canonical.includes(t));
  console.log(`=== ${doc}`);
  console.log(`  missing: ${missing.join(' | ')}`);
}
