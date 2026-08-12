#!/usr/bin/env node

import { resolve } from 'node:path';
import { validateExecutionPromptSemantics } from './session-execution-prompt-semantics.mjs';

function parseRoot(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === '--root' && argv[1]) return resolve(argv[1]);
  console.error('Usage: node scripts/lint-session-execution-prompts.mjs [--root <path>]');
  process.exit(2);
}

const root = parseRoot(process.argv.slice(2));
const errors = validateExecutionPromptSemantics(root);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  console.error(`session-execution prompt semantics failed: ${errors.length} issue(s)`);
  process.exit(1);
}

console.log('session-execution prompt semantics passed');
