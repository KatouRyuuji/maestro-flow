// Overlay this project's compiled files onto a matching official maestro-flow.
// Scenario: npm i -g maestro-flow@<repo version> first, then run this patcher.
// Never replace whole dist / dashboard trees or touch official node_modules.
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';

function filePatch(rel, { source = null, markers = [] } = {}) {
  return { from: rel, to: rel, kind: 'file', source, markers };
}

/** Files this project must land on official 0.5.82. kind is always file. */
export const APPLY_ENTRIES = [
  filePatch(join('dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'grok-adapter.js'), {
    source: join('dashboard', 'src', 'server', 'agents', 'grok-adapter.ts'),
    markers: ['--no-auto-update'],
  }),
  filePatch(join('dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'adapter-factory.js'), {
    source: join('dashboard', 'src', 'server', 'agents', 'adapter-factory.ts'),
    markers: ['grok'],
  }),
  filePatch(join('dist', 'src', 'config', 'cli-tools-defaults.json'), {
    source: join('src', 'config', 'cli-tools-defaults.json'),
    markers: ['"name": "grok"'],
  }),
  filePatch(join('dist', 'src', 'agents', 'cli-agent-runner.js'), {
    source: join('src', 'agents', 'cli-agent-runner.ts'),
    markers: ['grok'],
  }),
  filePatch(join('dist', 'src', 'commands', 'delegate.js'), {
    source: join('src', 'commands', 'delegate.ts'),
    markers: ['grok'],
  }),
  filePatch(join('dist', 'src', 'core', 'component-defs.js'), {
    source: join('src', 'core', 'component-defs.ts'),
    markers: ['rules/maestro.md'],
  }),
  filePatch(join('dist', 'src', 'commands', 'install-backend.js'), {
    source: join('src', 'commands', 'install-backend.ts'),
    markers: ['grok', 'stripLegacyGrokAgentsAtGrokDir'],
  }),
  // 旧 AGENTS.md 剥离：官方包没有此文件，必须一并覆盖
  filePatch(join('dist', 'src', 'core', 'grok-legacy-agents.js'), {
    source: join('src', 'core', 'grok-legacy-agents.ts'),
    markers: ['stripLegacyGrokAgentsMd'],
  }),
  filePatch(join('dist', 'src', 'core', 'manifest.js'), {
    source: join('src', 'core', 'manifest.ts'),
    markers: ['maestro.md'],
  }),
  filePatch(join('workflows', 'delegate-usage.md'), {
    source: join('workflows', 'delegate-usage.md'),
    markers: ['grok'],
  }),
  filePatch(join('dist', 'src', 'hooks', 'session-context.js'), {
    source: join('src', 'hooks', 'session-context.ts'),
    markers: ['session/3.0'],
  }),
  filePatch(join('dist', 'src', 'run', 'continuation.js'), {
    source: join('src', 'run', 'continuation.ts'),
    markers: ['session/3.0'],
  }),
  filePatch(join('dist', 'src', 'run', 'v3', 'knowledge-v3.js'), {
    source: join('src', 'run', 'v3', 'knowledge-v3.ts'),
    markers: ['V3KnowledgeReconciliationError'],
  }),
  filePatch(join('dist', 'src', 'run', 'v3', 'mutation-engine.js'), {
    source: join('src', 'run', 'v3', 'mutation-engine.ts'),
    markers: ['knowledge reconciliation failed'],
  }),
  filePatch(join('dist', 'src', 'commands', 'hooks.js'), {
    source: join('src', 'commands', 'hooks.ts'),
    markers: ["h.command ?? ''"],
  }),
  filePatch(join('dist', 'src', 'commands', 'run-v3.js'), {
    source: join('src', 'commands', 'run-v3.ts'),
    markers: ['generateV3RunKnowledgeReconciliation'],
  }),
];

export const OVERLAY_MANIFEST_REL = '.maestro-grok-overlay.json';

const GROK_ADAPTER_REL = join(
  'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'grok-adapter.js',
);
const GROK_FACTORY_REL = join(
  'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'adapter-factory.js',
);
const GROK_DEFAULTS_REL = join('dist', 'src', 'config', 'cli-tools-defaults.json');

export function resolveRepoRoot() {
  return resolve(fileURLToPath(new URL('..', import.meta.url)));
}

export function resolveOfficialRoot() {
  const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
  return join(prefix, 'node_modules', 'maestro-flow');
}

export function readPackageVersion(pkgRoot) {
  const pkgPath = join(pkgRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export function overlayNeedsBuild(repoRoot) {
  for (const entry of APPLY_ENTRIES) {
    const built = join(repoRoot, entry.from);
    if (!existsSync(built)) return true;
    if (!entry.source) continue;
    const source = join(repoRoot, entry.source);
    if (!existsSync(source)) continue;
    if (statSync(source).mtimeMs > statSync(built).mtimeMs) return true;
  }
  return false;
}

export function collectApplyProblems(repoRoot, officialRoot) {
  const problems = [];
  const expectedVersion = readPackageVersion(repoRoot);
  if (!existsSync(officialRoot)) {
    const hint = expectedVersion
      ? `npm install -g maestro-flow@${expectedVersion}`
      : 'npm install -g maestro-flow@<本仓库版本>';
    problems.push(`未找到官方全局安装：${officialRoot}\n请先手动安装匹配版本：${hint}（脚本不会自动安装或降级）`);
  }
  const missing = APPLY_ENTRIES
    .filter((entry) => !existsSync(join(repoRoot, entry.from)))
    .map((entry) => entry.from);
  if (missing.length > 0) {
    problems.push(`本仓库尚未编译出覆盖产物：${missing.join('、')}\n请先执行：npm run build`);
  } else if (overlayNeedsBuild(repoRoot)) {
    problems.push('本仓库编译产物早于源码。请先执行：npm run build');
  } else {
    const precheck = verifyLocalOverlay(repoRoot);
    if (!precheck.ok) {
      problems.push(`本仓库产物未通过覆盖预检：${precheck.reason}\n请先执行：npm run build`);
    }
  }
  return problems;
}

function replaceFile(tmp, to) {
  try {
    renameSync(tmp, to);
  } catch {
    copyFileSync(tmp, to);
    unlinkSync(tmp);
  }
}

export function applyLocalOverlay(repoRoot, officialRoot) {
  const precheck = verifyLocalOverlay(repoRoot);
  if (!precheck.ok) {
    throw new Error(`本仓库产物未通过覆盖预检：${precheck.reason}`);
  }
  const staged = [];
  try {
    for (const entry of APPLY_ENTRIES) {
      const from = join(repoRoot, entry.from);
      const to = join(officialRoot, entry.to);
      if (!existsSync(from)) {
        throw new Error(`缺少源路径：${from}`);
      }
      mkdirSync(dirname(to), { recursive: true });
      const tmp = `${to}.maestro-overlay.tmp`;
      copyFileSync(from, tmp);
      staged.push({ tmp, to });
    }
    for (const item of staged) {
      replaceFile(item.tmp, item.to);
      item.tmp = null;
    }
    writeOverlayManifest(repoRoot, officialRoot);
  } catch (error) {
    for (const { tmp } of staged) {
      if (!tmp) continue;
      try { unlinkSync(tmp); } catch { /* already moved or missing */ }
    }
    throw error;
  }
}

export function writeOverlayManifest(repoRoot, officialRoot) {
  const files = APPLY_ENTRIES.map((entry) => {
    const abs = join(officialRoot, entry.to);
    return {
      path: entry.to.replace(/\\/g, '/'),
      sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
    };
  });
  const manifest = {
    schema: 'maestro-grok-overlay/1.0',
    repo_version: readPackageVersion(repoRoot),
    official_version: readPackageVersion(officialRoot),
    applied_at: new Date().toISOString(),
    files,
  };
  writeFileSync(
    join(officialRoot, OVERLAY_MANIFEST_REL),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

export function verifyLocalOverlay(officialRoot) {
  for (const entry of APPLY_ENTRIES) {
    const target = join(officialRoot, entry.to);
    if (!existsSync(target)) {
      return { ok: false, reason: `覆盖后仍缺少 ${entry.to}` };
    }
    const text = readFileSync(target, 'utf8');
    const missing = (entry.markers ?? []).filter((marker) => !text.includes(marker));
    if (missing.length > 0) {
      return { ok: false, reason: `覆盖后 ${entry.to} 缺少标记：${missing.join('、')}` };
    }
  }
  return {
    ok: true,
    adapter: join(officialRoot, GROK_ADAPTER_REL),
    defaultsPath: join(officialRoot, GROK_DEFAULTS_REL),
  };
}

function parseArgs(argv) {
  return {
    yes: argv.includes('-y') || argv.includes('--yes'),
    dryRun: argv.includes('--dry-run'),
    skipInstall: argv.includes('--no-install'),
  };
}

async function ask(question, defaultYes) {
  const rl = createInterface({ input, output });
  try {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const raw = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
    if (!raw) return defaultYes;
    return raw === 'y' || raw === 'yes';
  } finally {
    rl.close();
  }
}

export async function runApplyToOfficial(options = {}) {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const officialRoot = options.officialRoot ?? resolveOfficialRoot();
  const yes = options.yes === true;
  const dryRun = options.dryRun === true;
  const skipInstall = options.skipInstall === true;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const confirm = options.confirm ?? ask;
  const runMaestroInstall = options.runMaestroInstall ?? (() => {
    execSync('maestro install', { stdio: 'inherit', shell: true });
  });

  const localVersion = readPackageVersion(repoRoot) ?? 'unknown';
  const officialVersion = readPackageVersion(officialRoot) ?? 'unknown';

  log(`本仓库：${localVersion}`);
  log(`  ${repoRoot}`);
  log(`官方安装：${officialVersion}`);
  log(`  ${officialRoot}`);
  log('');
  log('将覆盖（不修改官方 node_modules 依赖）：');
  for (const entry of APPLY_ENTRIES) {
    log(`  ${entry.from}`);
  }

  if (!yes && options.confirm === undefined && input.isTTY === false) {
    log('');
    log('非交互环境请加 -y，例如：npm run apply-to-official -- -y');
    return { ok: false, code: 1 };
  }

  const problems = collectApplyProblems(repoRoot, officialRoot);
  if (problems.length > 0) {
    for (const problem of problems) {
      log('');
      log(problem);
    }
    return { ok: false, code: 1 };
  }

  if (localVersion !== officialVersion) {
    log('');
    log(`官方 ${officialVersion} 与本仓库 ${localVersion} 不一致。`);
    log(`请先手动安装匹配版本：npm install -g maestro-flow@${localVersion}`);
    log('脚本不会自动安装或降级官方包。');
    return { ok: false, code: 1, reason: 'official-version' };
  } else if (!yes) {
    log('');
    const proceed = await confirm('把本仓库产物叠到官方安装目录？', true);
    if (!proceed) {
      log('已取消。');
      return { ok: false, code: 0 };
    }
  }

  if (dryRun) {
    log('');
    log('dry-run：未写入任何文件。');
    return { ok: true, code: 0, dryRun: true };
  }

  applyLocalOverlay(repoRoot, officialRoot);
  const verified = verifyLocalOverlay(officialRoot);
  if (!verified.ok) {
    log('');
    log(`覆盖失败：${verified.reason}`);
    return { ok: false, code: 1 };
  }

  log('');
  log(`覆盖完成，清单已写入 ${OVERLAY_MANIFEST_REL}。`);

  if (!skipInstall && !yes) {
    log('');
    const runInstall = await confirm('是否接着运行 maestro install，探测并启用 grok？', true);
    if (runInstall) {
      runMaestroInstall();
    }
  }

  return { ok: true, code: 0 };
}

async function main() {
  const result = await runApplyToOfficial(parseArgs(process.argv.slice(2)));
  process.exitCode = result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
