import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface SectionOverrideSpec {
  id: string;
  startHeading: string;
  /** Heading that ends the replaced range; null = replace through end of body. */
  endHeading: string | null;
}

interface AgentOverrideSpec {
  file: string;
  sections: SectionOverrideSpec[];
}

const AGENT_OVERRIDE_SPECS: Record<string, AgentOverrideSpec> = {
  'team-worker': {
    file: 'team-worker.md',
    sections: [
      { id: 'prompt-input', startHeading: '### 1. Parse Prompt Input', endHeading: '### 2. Load Role Spec' },
      { id: 'assignment-lifecycle', startHeading: '### 3. Task Discovery', endHeading: '### 4. Load Upstream Context' },
      { id: 'execute-role-logic', startHeading: '### 5. Execute Role-Specific Logic', endHeading: '### Context-Aware Signal Emission (Optional)' },
      { id: 'milestone-protocol', startHeading: '### Progress Milestone Protocol', endHeading: '### 7. Report and Advance' },
      { id: 'report-and-advance', startHeading: '### 7. Report and Advance', endHeading: '## Input' },
      { id: 'input', startHeading: '## Input', endHeading: '## Output' },
      { id: 'output', startHeading: '## Output', endHeading: '## Constraints' },
      { id: 'constraints', startHeading: '## Constraints', endHeading: '## Message Bus Protocol' },
    ],
  },
  'team-supervisor': {
    file: 'team-supervisor.md',
    sections: [
      { id: 'role', startHeading: '## Role', endHeading: '## Process' },
      { id: 'prompt-input', startHeading: '### 1. Parse Prompt Input', endHeading: '### 2. Initialize' },
      { id: 'initialize', startHeading: '### 2. Initialize', endHeading: '### 3. Wake Cycle' },
      { id: 'wake-cycle', startHeading: '### 3. Wake Cycle', endHeading: '### 4. Crash Recovery' },
      { id: 'crash-recovery', startHeading: '### 4. Crash Recovery', endHeading: '### 5. Shutdown' },
      { id: 'shutdown', startHeading: '### 5. Shutdown', endHeading: '## Input' },
      { id: 'input', startHeading: '## Input', endHeading: '## Output' },
      { id: 'output', startHeading: '## Output', endHeading: '## Constraints' },
      { id: 'constraints', startHeading: '## Constraints', endHeading: '## Message Bus Protocol' },
      { id: 'message-protocol-reference', startHeading: '## Message Protocol Reference', endHeading: null },
    ],
  },
};

const OVERRIDE_BLOCK = /<!-- grok-agent-override:start section="([^"]+)" -->\s*([\s\S]*?)\s*<!-- grok-agent-override:end section="\1" -->/g;
const UNSUPPORTED_COLLAB_TOKEN = /\b(?:TaskList|TaskGet|TaskUpdate|SendMessage|TeamCreate|TeamDelete)\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseOverrideBlocks(content: string, file: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const match of content.matchAll(OVERRIDE_BLOCK)) {
    const [, id, body] = match;
    if (blocks.has(id)) throw new Error(`Duplicate Grok agent override section "${id}" in ${file}`);
    blocks.set(id, body.trim());
  }
  return blocks;
}

function replaceHeadingSection(
  body: string,
  section: SectionOverrideSpec,
  replacement: string,
  agentName: string,
): string {
  const pattern = section.endHeading === null
    ? new RegExp(`^${escapeRegExp(section.startHeading)}\\r?\\n[\\s\\S]*$`, 'm')
    : new RegExp(
      `^${escapeRegExp(section.startHeading)}\\r?\\n[\\s\\S]*?(?=^${escapeRegExp(section.endHeading)}\\r?$)`,
      'm',
    );
  if (!pattern.test(body)) {
    throw new Error(
      `Grok agent override ${agentName}:${section.id} cannot find source section ` +
      `${section.startHeading} -> ${section.endHeading ?? '<eof>'}`,
    );
  }
  const tail = section.endHeading === null ? '\n' : '\n\n';
  return body.replace(pattern, `${replacement.trimEnd()}${tail}`);
}

/** Apply explicit semantic overrides before generic Grok tool-name conversion. */
export function applyGrokAgentOverrides(
  agentName: string,
  body: string,
  overrideDir: string,
): string {
  const spec = AGENT_OVERRIDE_SPECS[agentName];
  if (!spec) return body;

  const overridePath = join(overrideDir, spec.file);
  if (!existsSync(overridePath)) {
    throw new Error(`Missing required Grok agent override: ${overridePath}`);
  }
  const blocks = parseOverrideBlocks(readFileSync(overridePath, 'utf8'), overridePath);
  let result = body;
  for (const section of spec.sections) {
    const replacement = blocks.get(section.id);
    if (!replacement) {
      throw new Error(`Missing Grok agent override section "${section.id}" in ${overridePath}`);
    }
    result = replaceHeadingSection(result, section, replacement, agentName);
  }
  return result;
}

/** Grok subagents have no task board, no SendMessage inbox, and no team tools. */
export function assertNoUnsupportedGrokTokens(agentName: string, body: string): void {
  const match = body.match(UNSUPPORTED_COLLAB_TOKEN);
  if (!match) return;
  throw new Error(
    `Grok agent "${agentName}" still contains unsupported ${match[0]} semantics; ` +
    'add an explicit section override instead of applying a tool-name substitution.',
  );
}
