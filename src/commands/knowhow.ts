/**
 * KnowHow Command — CLI for creating and searching reusable knowledge.
 *
 * Subcommands: add, list, search, get
 *
 * Operates offline by directly reading/writing .workflow/knowhow/ files.
 */

import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import {
  KNOWHOW_CATEGORIES as CATEGORIES,
  KNOWHOW_PREFIX_MAP as PREFIX_MAP,
  slugify,
  parseFrontmatter,
  getKnowhowDir,
  knowhowFileToWikiId,
} from '../utils/frontmatter.js';
import { getProjectRoot } from '../utils/path-validator.js';
import { handler as storeKnowhow } from '../tools/store-knowhow.js';
import {
  createKnowhowLifecycleSnapshot,
  getKnowhowEvolutionChain,
  recoverKnowhowLifecycleIntent,
  restoreKnowhowLifecycleSnapshot,
  sealKnowhowLifecycleSnapshot,
  supersedeKnowhowEntry,
} from '../tools/knowhow-lifecycle.js';

export function registerKnowhowCommand(program: Command): void {
  const knowhow = program
    .command('knowhow')
    .alias('kh')
    .description('Create, list, search knowhow entries (.workflow/knowhow/)');

  // ── add ────────────────────────────────────────────────────────────
  knowhow
    .command('add')
    .description('Create a new knowhow entry')
    .requiredOption('--type <type>', 'session|tip|template|recipe|reference|decision|document')
    .requiredOption('--title <title>', 'Entry title')
    .option('--body <text>', 'Entry body (markdown)')
    .option('--body-file <path>', 'Read body from file')
    .option('--id <stable-stem>', 'Stable explicit id (<prefix>-YYYYMMDD-<kebab-slug>)')
    .option('--tool', 'Mark this knowhow entry as a tool')
    .action(async (opts) => {
      const hasBody = opts.body !== undefined;
      const hasBodyFile = opts.bodyFile !== undefined;
      if (hasBody === hasBodyFile) {
        console.error('Exactly one of --body or --body-file is required');
        process.exitCode = 1;
        return;
      }

      const type = opts.type as string;
      if (!CATEGORIES.includes(type as any)) {
        console.error(`Unknown type: ${type}. Must be one of: ${CATEGORIES.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const body = opts.bodyFile ? readFileSync(opts.bodyFile, 'utf-8') : opts.body;
      const response = await storeKnowhow({
        operation: 'add',
        id: opts.id,
        type,
        title: opts.title,
        body,
        tool: opts.tool,
      });
      if (!response.success) {
        console.error(response.error);
        process.exitCode = 1;
        return;
      }
      const result = response.result as Record<string, unknown>;
      console.log(`${result.replayed ? 'Replayed' : 'Created'}: ${result.id}`);
      console.log(`  Type: ${result.type}`);
      console.log(`  File: ${result.path}`);
    });

  // ── supersede ───────────────────────────────────────────────────────
  knowhow
    .command('supersede <oldId>')
    .description('Deprecate a knowhow entry in favor of its successor')
    .requiredOption('--by <newId>', 'Replacement knowhow id')
    .option('--json', 'Output as JSON')
    .action((oldId: string, opts) => {
      const result = supersedeKnowhowEntry(getProjectRoot(), oldId, opts.by);
      if (!result.success) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.replayed ? 'Replayed' : 'Superseded'}: ${oldId} -> ${opts.by}`);
    });

  // ── history ─────────────────────────────────────────────────────────
  knowhow
    .command('history <id>')
    .description('Show the evolution chain containing a knowhow entry')
    .option('--json', 'Output as JSON')
    .action((id: string, opts) => {
      try {
        const entries = getKnowhowEvolutionChain(getProjectRoot(), id);
        const result = {
          schema_version: 'knowhow-history-result/1.0',
          operation: 'history',
          id,
          entries,
        };
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`Knowhow history (${entries.length})`);
          for (const entry of entries) {
            console.log(`  ${entry.current ? '*' : '-'} ${entry.id}${entry.broken ? ' [broken]' : ''}`);
          }
        }
      } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
      }
    });

  // ── recover ─────────────────────────────────────────────────────────
  knowhow
    .command('recover')
    .description('Explicitly recover a pending knowhow lifecycle intent')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const result = recoverKnowhowLifecycleIntent(getProjectRoot());
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else if (result.success) {
        console.log(result.replayed
          ? 'Recovered pending knowhow lifecycle intent'
          : 'No pending knowhow lifecycle intent');
      } else {
        console.error(result.error);
      }
      if (!result.success) process.exitCode = 1;
    });

  // ── snapshot ────────────────────────────────────────────────────────
  const snapshot = knowhow
    .command('snapshot')
    .description('Create and seal hash-fenced knowhow lifecycle snapshots');

  snapshot
    .command('create')
    .requiredOption('--old <id>', 'Existing knowhow id')
    .requiredOption('--new <id>', 'New knowhow id')
    .requiredOption('--new-path <path>', 'Expected new file path relative to the project')
    .option('--include-relative <path...>', 'Additional project-relative paths')
    .requiredOption('--out <path>', 'Snapshot output path')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      try {
        const result = createKnowhowLifecycleSnapshot(getProjectRoot(), {
          oldId: opts.old,
          newId: opts.new,
          newPath: opts.newPath,
          includeRelative: opts.includeRelative,
          out: opts.out,
        });
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`Snapshot created: ${opts.out}`);
      } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
      }
    });

  snapshot
    .command('seal')
    .requiredOption('--snapshot <path>', 'Snapshot path')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      try {
        const result = sealKnowhowLifecycleSnapshot(getProjectRoot(), opts.snapshot);
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`Snapshot sealed: ${opts.snapshot}`);
      } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
      }
    });

  // ── restore ─────────────────────────────────────────────────────────
  knowhow
    .command('restore')
    .description('Restore a sealed knowhow lifecycle snapshot')
    .requiredOption('--snapshot <path>', 'Snapshot path')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const result = restoreKnowhowLifecycleSnapshot(
        getProjectRoot(),
        opts.snapshot,
      );
      if (!result.success) {
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else console.error(result.error);
        process.exitCode = 1;
        return;
      }
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Restored snapshot: ${opts.snapshot}`);
    });

  // ── list ───────────────────────────────────────────────────────────
  knowhow
    .command('list')
    .alias('ls')
    .description('List knowhow entries')
    .option('--type <type>', 'Filter by type')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const dir = getKnowhowDir();
      if (!existsSync(dir)) {
        console.log('No knowhow entries yet.');
        return;
      }

      const entries: Array<{ id: string; filename: string; title: string; type: string; tags: string; created: string }> = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const raw = readFileSync(join(dir, name), 'utf-8');
        const { data } = parseFrontmatter(raw);
        if (opts.type && data.type !== opts.type) continue;
        const prefix = name.match(/^([A-Z]+)-\d{8}/)?.[1] ?? '';
        const typeCat = Object.entries(PREFIX_MAP).find(([, p]) => p === prefix)?.[0] ?? '';
        entries.push({
          id: knowhowFileToWikiId(name),
          filename: name,
          title: data.title || 'Untitled',
          type: typeCat || data.type || '',
          tags: data.tags || '',
          created: data.created || '',
        });
      }

      if (opts.json) {
        console.log(JSON.stringify({ entries }, null, 2));
        return;
      }

      console.log(`Knowhow entries (${entries.length})`);
      for (const e of entries) {
        console.log(`  [${e.type}] ${e.id}  ${e.title}  ${e.created ? `(${e.created.slice(0, 10)})` : ''}`);
      }
    });

  // ── search ─────────────────────────────────────────────────────────
  knowhow
    .command('search <query...>')
    .description('Search knowhow entries by keyword')
    .option('--json', 'Output as JSON')
    .option('--limit <n>', 'Max results', (v) => parseInt(v, 10), 20)
    .action(async (queryParts: string[], opts) => {
      console.warn('[deprecated] Use "maestro search --type knowhow" instead');
      const q = queryParts.join(' ');
      const limit = opts.limit > 0 ? opts.limit : 20;
      const { runUnifiedSearch } = await import('./search.js');
      const results = await runUnifiedSearch(q, { type: 'knowhow', limit });

      if (opts.json) {
        console.log(JSON.stringify({ query: q, matches: results, total_matches: results.length }, null, 2));
        return;
      }

      console.log(`Query: "${q}"  (${results.length} results)`);
      for (const r of results) {
        const scoreTag = r.score !== null ? `  (score: ${r.score.toFixed(2)})` : '';
        console.log(`  [${r.type}] ${r.id}  ${r.title}${scoreTag}`);
        const excerpt = r.snippet || r.summary;
        if (excerpt) console.log(`    ${excerpt}`);
      }
    });

  // ── get ────────────────────────────────────────────────────────────
  knowhow
    .command('get <id>')
    .description('View a knowhow entry')
    .option('--json', 'Output as JSON')
    .action(async (id: string, opts) => {
      const dir = getKnowhowDir();
      if (!existsSync(dir)) {
        console.error('No knowhow entries found.');
        process.exit(1);
      }

      // Try to match by partial id
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const slug = slugify(name.replace(/^...-/, '').replace('.md', ''));
        if (id.includes(slug) || `knowhow-${slug}` === id) {
          const raw = readFileSync(join(dir, name), 'utf-8');
          if (opts.json) {
            const { data, body } = parseFrontmatter(raw);
            console.log(JSON.stringify({ entry: { id, ...data, body } }, null, 2));
            return;
          }
          console.log(raw);
          return;
        }
      }

      console.error(`Entry not found: ${id}`);
      process.exit(1);
    });
}
