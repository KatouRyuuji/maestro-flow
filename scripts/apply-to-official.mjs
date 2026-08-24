// 把本仓库已编译产物叠到官方全局 maestro-flow，不碰官方 node_modules。
import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';

export const APPLY_ENTRIES = [
  { from: 'dist', to: 'dist', kind: 'dir' },
  { from: join('dashboard', 'dist-server'), to: join('dashboard', 'dist-server'), kind: 'dir' },
  { from: join('dashboard', 'dist'), to: join('dashboard', 'dist'), kind: 'dir' },
  { from: 'shared', to: 'shared', kind: 'dir' },
  {
    from: join('workflows', 'delegate-usage.md'),
    to: join('workflows', 'delegate-usage.md'),
    kind: 'file',
  },
];

const GROK_ADAPTER_REL = join(
  'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'grok-adapter.js',
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

export function collectApplyProblems(repoRoot, officialRoot) {
  const problems = [];
  if (!existsSync(officialRoot)) {
    problems.push(`未找到官方全局安装：${officialRoot}\n请先执行：npm install -g maestro-flow@latest`);
  }
  for (const entry of APPLY_ENTRIES) {
    const from = join(repoRoot, entry.from);
    if (!existsSync(from)) {
      problems.push(`本仓库缺少待覆盖路径：${entry.from}\n请先执行：npm run build`);
    }
  }
  if (!existsSync(join(repoRoot, GROK_ADAPTER_REL))) {
    problems.push(`本仓库尚未编译出 Grok 产物：${GROK_ADAPTER_REL}\n请先执行：npm run build`);
  }
  if (!existsSync(join(repoRoot, 'dashboard', 'dist', 'index.html'))) {
    problems.push('本仓库尚未编译 Dashboard 前端：dashboard/dist/index.html\n请先执行：npm run build:dashboard');
  }
  if (!existsSync(join(repoRoot, GROK_DEFAULTS_REL))) {
    problems.push(`本仓库缺少编译后的 cli-tools-defaults.json\n请先执行：npm run build`);
  }
  return problems;
}

export function applyLocalOverlay(repoRoot, officialRoot) {
  for (const entry of APPLY_ENTRIES) {
    const from = join(repoRoot, entry.from);
    const to = join(officialRoot, entry.to);
    if (!existsSync(from)) {
      throw new Error(`缺少源路径：${from}`);
    }
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, force: true });
  }
}

export function verifyLocalOverlay(officialRoot) {
  const adapter = join(officialRoot, GROK_ADAPTER_REL);
  if (!existsSync(adapter)) {
    return { ok: false, reason: `覆盖后仍缺少 ${adapter}` };
  }
  const defaultsPath = join(officialRoot, GROK_DEFAULTS_REL);
  if (!existsSync(defaultsPath)) {
    return { ok: false, reason: `覆盖后仍缺少 ${defaultsPath}` };
  }
  const defaults = readFileSync(defaultsPath, 'utf8');
  if (!defaults.includes('"name": "grok"')) {
    return { ok: false, reason: '覆盖后 cli-tools-defaults.json 未包含 grok' };
  }
  const factoryPath = join(
    officialRoot, 'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'adapter-factory.js',
  );
  if (existsSync(factoryPath)) {
    const factory = readFileSync(factoryPath, 'utf8');
    if (!factory.includes("'grok'") && !factory.includes('"grok"')) {
      return { ok: false, reason: '覆盖后 adapter-factory.js 未注册 grok' };
    }
  }
  const dashboardIndex = join(officialRoot, 'dashboard', 'dist', 'index.html');
  if (!existsSync(dashboardIndex)) {
    return { ok: false, reason: `覆盖后仍缺少 ${dashboardIndex}` };
  }
  return { ok: true, adapter, defaultsPath };
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

  if (officialVersion !== 'unknown' && localVersion !== officialVersion) {
    log('');
    log(`警告：官方 ${officialVersion} 与本仓库 ${localVersion} 不一致，覆盖可能不兼容。`);
    if (!yes) {
      const proceed = await confirm('仍要继续？', false);
      if (!proceed) {
        log('已取消。');
        return { ok: false, code: 0 };
      }
    }
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
  log('覆盖完成，Grok 适配已写入官方安装目录。');

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
