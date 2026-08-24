// Interactive Grok overlay install:
// 1) deps  2) official version  3) grok CLI  4) simulate  5) confirm
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  applyLocalOverlay,
  collectApplyProblems,
  overlayNeedsBuild,
  readPackageVersion,
  resolveOfficialRoot,
  resolveRepoRoot,
  verifyLocalOverlay,
} from './apply-to-official.mjs';

export const SHARED_COMPONENT_IDS = [
  'workflows',
  'prepare',
  'ref',
  'arch-kb',
  'templates',
  'overlays',
];

export const GROK_COMPONENT_IDS = [
  'grok-context',
  'grok-md-chinese',
  'grok-skills',
  'grok-agents',
];

const MIN_NODE = '22.19.0';
const GROK_ADAPTER_REL = join(
  'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'grok-adapter.js',
);
const GROK_FACTORY_REL = join(
  'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'agents', 'adapter-factory.js',
);
const GROK_DEFAULTS_REL = join('dist', 'src', 'config', 'cli-tools-defaults.json');

export function parseNodeMajorMinor(version) {
  const match = String(version).replace(/^v/, '').match(/^(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function nodeMeetsMinimum(current, minimum = MIN_NODE) {
  const have = parseNodeMajorMinor(current);
  const need = parseNodeMajorMinor(minimum);
  if (!have || !need) return false;
  if (have.major !== need.major) return have.major > need.major;
  return have.minor >= need.minor;
}

/** Node 22.x below 22.19 can still overlay Grok; only <22 or missing Node is fatal. */
export function nodeCanRunOverlay(current) {
  const have = parseNodeMajorMinor(current);
  return Boolean(have && have.major >= 22);
}

export function quoteCliArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

export function formatCliCommand(bin, args) {
  return [quoteCliArg(bin), ...args.map(quoteCliArg)].join(' ');
}

export function needsOfficialPackage(officialVersion, expectedVersion) {
  return officialVersion !== expectedVersion;
}

export function needsRepoDependencies(repoRoot) {
  return !existsSync(join(repoRoot, 'node_modules'));
}

export function needsRepoBuild(repoRoot) {
  return overlayNeedsBuild(repoRoot);
}

export function resolveMaestroBin(npmPrefix, platform = process.platform) {
  if (platform === 'win32') {
    const cmd = join(npmPrefix, 'maestro.cmd');
    if (existsSync(cmd)) return cmd;
    return join(npmPrefix, 'maestro');
  }
  return join(npmPrefix, 'bin', 'maestro');
}

export function buildMaestroInstallArgs() {
  return [
    'install',
    '--force',
    '--global',
    '--components',
    [...SHARED_COMPONENT_IDS, ...GROK_COMPONENT_IDS].join(','),
    '--extra-mcp',
    'grok',
  ];
}

export function buildMaestroProjectInstallArgs(projectPath) {
  return [
    'install',
    '--force',
    '--path',
    projectPath,
    '--components',
    GROK_COMPONENT_IDS.join(','),
  ];
}

export function parseInstallArgs(argv) {
  let projectPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path') {
      const value = argv[i + 1];
      if (value && !String(value).startsWith('-')) {
        projectPath = resolve(value);
        i += 1;
      }
    }
  }
  return {
    dryRun: argv.includes('--dry-run'),
    rebuild: argv.includes('--rebuild'),
    skipOfficial: argv.includes('--skip-official'),
    skipBuild: argv.includes('--skip-build'),
    skipAssets: argv.includes('--skip-assets'),
    yes: argv.includes('-y') || argv.includes('--yes'),
    projectPath,
  };
}

export function nodeInstallHint(platform = process.platform) {
  if (platform === 'win32') {
    return [
      '升级：关 IDE/终端后，在新的 PowerShell 执行',
      '            winget install -e --id OpenJS.NodeJS.22',
      '            或到 https://nodejs.org 下载 22.x 安装包覆盖当前安装',
      '            装完重开终端，确认 node -v 为 22.19+',
    ].join('\n');
  }
  return '升级：用 nvm/fnm 安装 22.19+，或到 https://nodejs.org 下载 22.x';
}

export function fts5InstallHint() {
  return '不影响 Grok 覆盖与派活。知识库需换官方 Node 安装包（带 FTS5），见 INSTALL.md';
}

export function npmInstallHint() {
  return '安装：重装 Node.js（npm 随 Node 一起提供），然后重新打开终端';
}

export function grokInstallHint(platform = process.platform) {
  const install = platform === 'win32'
    ? '安装：irm https://x.ai/cli/install.ps1 | iex'
    : '安装：curl -fsSL https://x.ai/cli/install.sh | bash';
  return `${install}\n            然后：grok login   或设置 XAI_API_KEY`;
}

export function officialInstallHint(expectedVersion) {
  return `请先手动安装匹配版本：npm install -g maestro-flow@${expectedVersion}（脚本不会自动安装或降级）`;
}

/** 不改 trusted_folders.toml，只告诉用户怎么在 Grok 里信任当前目录。 */
export function grokTrustHint() {
  return [
    '在该目录开一次交互 grok，出现信任提示时确认，或在 TUI 执行 /hooks-trust',
    '然后：grok inspect   确认 projectTrusted 为 true',
    '用户级 ~/.grok/config.toml 的 maestro-tools 不受影响，脚本不会改 trusted_folders.toml',
  ].join('\n');
}

export function normalizeTrustPath(value) {
  return resolve(String(value)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function parseTrustedFolderEntries(toml) {
  const entries = [];
  let currentPath = null;
  for (const line of String(toml).split(/\r?\n/)) {
    const header = line.match(/^\[folders\.(?:'([^']+)'|"([^"]+)")\]\s*(?:#.*)?$/);
    if (header) {
      currentPath = header[1] ?? header[2];
      continue;
    }
    const trusted = line.match(/^\s*trusted\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (currentPath && trusted) {
      entries.push({ path: currentPath, trusted: trusted[1] === 'true' });
    }
  }
  return entries;
}

export function isGrokFolderTrusted(projectPath, entries) {
  const target = normalizeTrustPath(projectPath);
  return (entries ?? []).some((entry) => {
    if (!entry.trusted) return false;
    const root = normalizeTrustPath(entry.path);
    return target === root || target.startsWith(`${root}/`);
  });
}

export function inspectGrokFolderTrust({ projectPath, tomlText }) {
  const parsed = parseTrustedFolderEntries(tomlText ?? '');
  const ok = isGrokFolderTrusted(projectPath, parsed);
  return {
    ok,
    current: ok ? '已信任（项目级 MCP / hooks 可用）' : '未信任（项目级 MCP / hooks 会被跳过）',
    how: grokTrustHint(),
    blocking: false,
  };
}

export function readTrustedFoldersToml(home = homedir()) {
  const file = join(home, '.grok', 'trusted_folders.toml');
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export async function defaultStripLegacyGrokAgents(filePath, repoRoot = resolveRepoRoot()) {
  const built = join(repoRoot, 'dist', 'src', 'core', 'grok-legacy-agents.js');
  if (!existsSync(built)) return 'absent';
  const { stripLegacyGrokAgentsMd } = await import(pathToFileURL(built).href);
  return stripLegacyGrokAgentsMd(filePath);
}

function defaultRunner(command, options = {}) {
  execSync(command, {
    stdio: 'inherit',
    shell: true,
    ...options,
  });
}

export function probeCommand(bin, extraArgs = ['--version']) {
  try {
    const out = execSync([bin, ...extraArgs].join(' '), {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true,
    });
    const version = String(out).trim().split(/\r?\n/).find(Boolean) ?? '';
    return { ok: true, version };
  } catch {
    return { ok: false, version: null };
  }
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

function mark(ok) {
  return ok ? '就绪' : '未满足';
}

export function probeFts5() {
  try {
    execSync(
      'node -e "const {DatabaseSync}=require(\'node:sqlite\'); const d=new DatabaseSync(\':memory:\'); d.exec(\'CREATE VIRTUAL TABLE t USING fts5(c)\');"',
      { stdio: 'ignore', timeout: 8000, shell: true },
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function inspectDependencies({
  repoRoot,
  nodeVersion,
  npmProbe,
  fts5Probe,
  platform = process.platform,
}) {
  const nodeOk = nodeMeetsMinimum(nodeVersion, MIN_NODE);
  const nodeRunnable = nodeCanRunOverlay(nodeVersion);
  const npmOk = npmProbe?.ok === true;
  const depsOk = !needsRepoDependencies(repoRoot);
  const adapter = existsSync(join(repoRoot, GROK_ADAPTER_REL));
  const factory = existsSync(join(repoRoot, GROK_FACTORY_REL));
  const defaults = existsSync(join(repoRoot, GROK_DEFAULTS_REL));
  const stale = overlayNeedsBuild(repoRoot);
  const buildOk = adapter && factory && defaults && !stale;
  const fts5Ok = fts5Probe?.ok === true;
  // Missing Node, Node < 22, or missing npm cannot run the overlay. 22.14-style
  // minors only fail the recommended version / FTS5 checks.
  const blocking = !nodeRunnable || !npmOk;
  return {
    node: {
      current: nodeVersion,
      required: `≥ ${MIN_NODE}`,
      ok: nodeOk,
      how: nodeInstallHint(platform),
    },
    npm: {
      current: npmOk ? (npmProbe.version || '已找到') : '未找到',
      ok: npmOk,
      how: npmInstallHint(),
    },
    repoDeps: {
      current: depsOk ? `已有 ${join(repoRoot, 'node_modules')}` : '未安装 node_modules',
      ok: depsOk,
      how: `安装：在 ${repoRoot} 执行 npm install（确认后脚本会做）`,
    },
    build: {
      current: buildOk
        ? '编译产物已齐且不早于源码'
        : stale && adapter && factory && defaults
          ? '编译产物早于源码，需要重编'
          : `缺少：${[
            !adapter ? 'grok-adapter.js' : null,
            !factory ? 'adapter-factory.js' : null,
            !defaults ? 'cli-tools-defaults.json' : null,
          ].filter(Boolean).join('、') || '覆盖清单中的编译文件'}`,
      ok: buildOk,
      how: '安装：在 repo/ 执行 npm run build（确认后脚本会做）',
    },
    fts5: {
      current: fts5Ok ? '可用' : '不可用（知识库 maestro kg / search 会失败）',
      ok: fts5Ok,
      how: fts5InstallHint(),
    },
    blocking,
    ok: nodeOk && npmOk && depsOk && buildOk,
  };
}

export function inspectOfficial({ officialRoot, officialVersion, expectedVersion }) {
  const installed = Boolean(officialVersion);
  const ok = officialVersion === expectedVersion;
  const current = installed
    ? `${officialVersion}${ok ? '（与本仓库一致）' : `（本仓库要 ${expectedVersion}）`}`
    : `未安装（目标目录 ${officialRoot}）`;
  return {
    expected: expectedVersion,
    official: officialVersion,
    officialRoot,
    ok,
    current,
    how: officialInstallHint(expectedVersion),
    blocking: false,
  };
}

export function inspectGrokCli({ grokProbe, platform = process.platform }) {
  const ok = grokProbe?.ok === true;
  return {
    ok,
    current: ok ? (grokProbe.version || '已找到 grok') : '未找到 grok 命令',
    how: grokInstallHint(platform),
    blocking: false,
  };
}

export function inspectOverlay(officialRoot) {
  if (!officialRoot || !existsSync(officialRoot)) {
    return {
      ok: false,
      current: '官方目录不存在（先装官方包）',
      how: '安装：请先手动安装匹配版本的官方包，再跑本脚本覆盖',
      blocking: false,
    };
  }
  const verified = verifyLocalOverlay(officialRoot);
  return {
    ok: verified.ok === true,
    current: verified.ok ? '覆盖清单已写入官方目录' : (verified.reason || '未覆盖'),
    how: '安装：确认后脚本会把本仓库产物叠到官方目录（npm update -g 后必须再跑一次）',
    blocking: false,
  };
}

export function planInstallSteps({
  deps,
  official,
  skipOfficial = false,
  skipBuild = false,
  skipAssets = false,
  rebuild = false,
  projectPath,
}) {
  const steps = [];
  if (!skipOfficial && !official.ok) {
    steps.push(`需手动安装官方 CLI maestro-flow@${official.expected}（脚本不会自动安装或降级）`);
  }
  if (!skipBuild && !deps.repoDeps.ok) {
    steps.push('安装本仓库依赖（npm install）');
  }
  if (!skipBuild && (rebuild || !deps.build.ok)) {
    steps.push('编译本仓库（npm run build）');
  }
  steps.push('覆盖官方安装目录（不改官方 node_modules）');
  if (!skipAssets) {
    steps.push(`写入全局 Grok 资产与 MCP：maestro ${buildMaestroInstallArgs().join(' ')}`);
    if (projectPath) {
      steps.push(`写入当前目录 Grok 资产：maestro ${buildMaestroProjectInstallArgs(projectPath).join(' ')}`);
    }
  }
  return steps;
}

function printCheck(log, title, rows) {
  log(title);
  for (const row of rows) {
    log(`  ${row.label.padEnd(10)} ${row.current}    [${mark(row.ok)}]`);
    if (!row.ok) {
      for (const line of String(row.how).split('\n')) {
        log(`            ${line.replace(/^安装：/, '安装：')}`);
      }
    }
  }
  log('');
}

export async function runInstallGrok(options = {}) {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const officialRoot = options.officialRoot ?? resolveOfficialRoot();
  const dryRun = options.dryRun === true;
  const rebuild = options.rebuild === true;
  const skipOfficial = options.skipOfficial === true;
  const skipBuild = options.skipBuild === true;
  const skipAssets = options.skipAssets === true;
  const yes = options.yes === true;
  const platform = options.platform ?? process.platform;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const run = options.run ?? defaultRunner;
  const confirm = options.confirm ?? ask;
  const npmPrefix = options.npmPrefix ?? (() => execSync('npm prefix -g', { encoding: 'utf8' }).trim());
  const probeGrok = options.probeGrok ?? (() => probeCommand('grok'));
  const probeNpm = options.probeNpm ?? (() => probeCommand('npm'));
  const probeFts5Fn = options.probeFts5 ?? probeFts5;
  const nodeVersion = options.nodeVersion ?? process.version;
  const projectPath = options.projectPath ?? process.cwd();
  const isTty = options.isTty ?? input.isTTY === true;
  const stripLegacy = options.stripLegacyGrokAgents ?? defaultStripLegacyGrokAgents;
  const trustedToml = options.trustedFoldersToml ?? readTrustedFoldersToml();

  const expectedVersion = readPackageVersion(repoRoot);
  if (!expectedVersion) {
    log(`读不到本仓库版本：${join(repoRoot, 'package.json')}`);
    return { ok: false, code: 1, reason: 'repo' };
  }

  const grokProbe = typeof probeGrok === 'function'
    ? normalizeProbe(probeGrok())
    : normalizeProbe(probeGrok);
  const npmProbe = typeof probeNpm === 'function'
    ? normalizeProbe(probeNpm())
    : normalizeProbe(probeNpm);

  const fts5Probe = typeof probeFts5Fn === 'function'
    ? normalizeProbe(probeFts5Fn())
    : normalizeProbe(probeFts5Fn);

  const deps = inspectDependencies({
    repoRoot,
    nodeVersion,
    npmProbe,
    fts5Probe,
    platform,
  });
  const official = inspectOfficial({
    officialRoot,
    officialVersion: readPackageVersion(officialRoot),
    expectedVersion,
  });
  const overlay = inspectOverlay(officialRoot);
  const grok = inspectGrokCli({ grokProbe, platform });
  const steps = planInstallSteps({
    deps,
    official,
    skipOfficial,
    skipBuild,
    skipAssets,
    rebuild,
    projectPath,
  });

  log(`Maestro Grok 适配安装  ${expectedVersion}`);
  log(`仓库：${repoRoot}`);
  log(`当前目录：${projectPath}`);
  log('');

  printCheck(log, '[1/5] 检查依赖', [
    { label: 'Node.js', current: `${deps.node.current}（需要 ${deps.node.required}）`, ok: deps.node.ok, how: deps.node.how },
    { label: 'npm', current: deps.npm.current, ok: deps.npm.ok, how: deps.npm.how },
    { label: 'FTS5', current: deps.fts5.current, ok: deps.fts5.ok, how: deps.fts5.how },
    { label: '仓库依赖', current: deps.repoDeps.current, ok: deps.repoDeps.ok, how: deps.repoDeps.how },
    { label: '编译产物', current: deps.build.current, ok: deps.build.ok, how: deps.build.how },
  ]);

  printCheck(log, '[2/5] 检查官方版本', [
    { label: '本仓库', current: official.expected, ok: true, how: '' },
    { label: '官方全局', current: official.current, ok: official.ok, how: official.how },
    { label: 'Grok覆盖', current: overlay.current, ok: overlay.ok, how: overlay.how },
  ]);

  printCheck(log, '[3/5] 检查 Grok CLI', [
    { label: 'grok', current: grok.current, ok: grok.ok, how: grok.how },
  ]);
  if (grok.ok) {
    log('            登录：grok login   或设置 XAI_API_KEY');
    log('');
  }

  log('[4/5] 模拟安装（不会写盘）');
  if (steps.length === 0) {
    log('  没有需要执行的步骤。');
  } else {
    steps.forEach((step, index) => {
      log(`  ${index + 1}. ${step}`);
    });
  }
  log('');

  if (deps.blocking) {
    log('[5/5] 确认安装');
    log('  依赖未就绪：需要 Node 22+ 和 npm。先按上面的「升级」提示处理，再重新运行本脚本。');
    return { ok: false, code: 1, reason: deps.npm.ok ? 'node' : 'npm', deps, official, grok, steps };
  }
  if (!deps.node.ok) {
    log('  提示：当前 Node 低于 22.19，Grok 覆盖仍会安装；知识库可能不可用，建议稍后升级。');
    log('');
  }

  if (dryRun) {
    log('[5/5] 确认安装');
    log('  --dry-run：到此为止，未写入任何文件。');
    return { ok: true, code: 0, dryRun: true, deps, official, grok, steps };
  }

  if (!skipOfficial && needsOfficialPackage(official.official, official.expected)) {
    log('[5/5] 确认安装');
    log('  官方版本不一致或未安装。请先手动安装匹配版本，脚本不会自动安装或降级。');
    log(`  ${official.how}`);
    return { ok: false, code: 1, reason: 'official', deps, official, grok, steps };
  }

  if (!yes) {
    if (options.confirm === undefined && !isTty) {
      log('[5/5] 确认安装');
      log('  非交互环境请加 -y，例如：npm run install:grok -- -y');
      return { ok: false, code: 1, reason: 'confirm', deps, official, grok, steps };
    }
    log('[5/5] 确认安装');
    if (!grok.ok) {
      log('  Grok CLI 还没装好：脚本不会代装，装完才能真正派活。');
    }
    const proceed = await confirm('按上面的模拟步骤开始安装？', true);
    if (!proceed) {
      log('已取消。');
      return { ok: false, code: 0, reason: 'cancelled', deps, official, grok, steps };
    }
    log('');
  } else {
    log('[5/5] 确认安装    已使用 -y，直接执行');
    log('');
  }

  if (!skipBuild && !deps.repoDeps.ok) {
    run('npm install', { cwd: repoRoot });
  }
  if (!skipBuild && (rebuild || !deps.build.ok)) {
    run('npm run build', { cwd: repoRoot });
  }

  const problems = collectApplyProblems(repoRoot, officialRoot);
  if (problems.length > 0) {
    for (const problem of problems) {
      log('');
      log(problem);
    }
    return { ok: false, code: 1, reason: 'overlay-precheck', deps, official, grok, steps };
  }
  applyLocalOverlay(repoRoot, officialRoot);
  const verified = verifyLocalOverlay(officialRoot);
  if (!verified.ok) {
    log(`覆盖失败：${verified.reason}`);
    return { ok: false, code: 1, reason: 'overlay', deps, official, grok, steps };
  }

  const legacyAgents = [
    await stripLegacy(join(homedir(), '.grok', 'AGENTS.md'), repoRoot),
    await stripLegacy(join(projectPath, '.grok', 'AGENTS.md'), repoRoot),
  ];

  if (!skipAssets) {
    const prefix = typeof npmPrefix === 'function' ? npmPrefix() : npmPrefix;
    const maestroBin = resolveMaestroBin(prefix);
    const maestroCmd = existsSync(maestroBin) ? maestroBin : 'maestro';
    run(formatCliCommand(maestroCmd, buildMaestroInstallArgs()), { cwd: repoRoot });
    run(formatCliCommand(maestroCmd, buildMaestroProjectInstallArgs(projectPath)), { cwd: projectPath });
  }

  log('');
  log('安装完成。');
  if (legacyAgents.some((item) => item === 'stripped' || item === 'deleted')) {
    log('已从旧落点 .grok/AGENTS.md 剥掉 Maestro 段（用户正文保留）。指令只以 .grok/rules/maestro.md 为准。');
  }
  if (!grok.ok) {
    log('还差 Grok CLI：');
    for (const line of grok.how.split('\n')) log(`  ${line.trim()}`);
  } else {
    log('建议验证：');
    log('  grok mcp doctor maestro-tools');
    log('  maestro delegate "读 README 并总结" --to grok --mode analysis');
  }
  const trust = inspectGrokFolderTrust({ projectPath, tomlText: trustedToml });
  if (!trust.ok) {
    log('');
    log(`Grok 文件夹信任：${trust.current}`);
    for (const line of String(trust.how).split('\n')) log(`  ${line.trim()}`);
  }
  if (!deps.node.ok || !deps.fts5.ok) {
    log('');
    log('Node / FTS5 未达推荐配置，知识库不可用。升级步骤见 INSTALL.md。');
  }
  log('');
  log('升级官方包会冲掉覆盖，再跑一次本脚本即可。');

  return { ok: true, code: 0, deps, official, overlay, grok, steps, grokOk: grok.ok, trust, legacyAgents };
}

function normalizeProbe(value) {
  if (value && typeof value === 'object' && 'ok' in value) {
    return { ok: value.ok === true, version: value.version ?? null };
  }
  return { ok: value === true, version: value === true ? 'ok' : null };
}

async function main() {
  const flags = parseInstallArgs(process.argv.slice(2));
  const result = await runInstallGrok(flags);
  process.exitCode = result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
