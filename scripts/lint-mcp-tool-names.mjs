import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// MCP 工具限定名防回归：
// - 本仓安装固定把 maestro MCP 注册为服务器名 maestro-tools（src/commands/install-backend.ts
//   MAESTRO_MCP_SERVER_NAME），因此 mcp__maestro__* 与旧名 mcp__ccw-tools__* 在所有宿主上
//   都不存在；源文档引用它们会让子代理按死名调用，回报/状态更新静默丢失。
// - 源文档正文一律用裸名 team_msg；frontmatter allowed-tools 里仅允许
//   mcp__maestro-tools__* 与宿主第三方服务（mcp__exa__*）。
// - 生成镜像（.agy/.codex/.agents/）同样不允许死名残留。

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const DEAD_NAME = /\bmcp__(?:maestro|ccw-tools)__[A-Za-z0-9_]+/g;
const ANY_QUALIFIED = /\bmcp__([A-Za-z0-9-]+)__([A-Za-z0-9_]+)\b/g;
const ALLOWED_IN_FRONTMATTER = new Set(['maestro-tools', 'exa']);

const SOURCE_DIRS = ['.claude'];
const MIRROR_DIRS = ['.agy', '.codex', '.agents'];
const SCAN_EXT = new Set(['.md', '.toml']);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (SCAN_EXT.has(entry.slice(entry.lastIndexOf('.')))) yield path;
  }
}

/** Frontmatter 内 allowed-tools 的值（inline 与块形式），带行号。 */
function allowedToolsEntries(lines) {
  const entries = [];
  if (lines[0] !== '---') return entries;
  const end = lines.findIndex((line, i) => i > 0 && line === '---');
  if (end === -1) return entries;
  for (let i = 1; i < end; i++) {
    const inline = lines[i].match(/^allowed-tools\s*:\s*(.+)$/);
    if (inline) {
      entries.push({ line: lines[i], lineno: i + 1 });
      continue;
    }
    if (/^allowed-tools\s*:\s*$/.test(lines[i])) {
      let j = i + 1;
      while (j < end && /^\s+-\s+/.test(lines[j])) {
        entries.push({ line: lines[j], lineno: j + 1 });
        j++;
      }
      i = j - 1;
    }
  }
  return entries;
}

const errors = [];

for (const scope of [...SOURCE_DIRS, ...MIRROR_DIRS]) {
  for (const path of walk(join(root, scope))) {
    const rel = relative(root, path);
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(DEAD_NAME)) {
        errors.push(`${rel}:${index + 1}: dead MCP server name "${match[0]}" (never registered; use bare team_msg in prose, mcp__maestro-tools__* in allowed-tools)`);
      }
    });
    if (scope === '.claude') {
      for (const { line, lineno } of allowedToolsEntries(lines)) {
        for (const match of line.matchAll(ANY_QUALIFIED)) {
          if (!ALLOWED_IN_FRONTMATTER.has(match[1])) {
            errors.push(`${rel}:${lineno}: allowed-tools references unregistered MCP server "${match[1]}" (allowed: ${[...ALLOWED_IN_FRONTMATTER].join(', ')})`);
          }
        }
      }
    }
  }
}

if (errors.length) {
  console.error(`mcp tool name lint failed: ${errors.length} issue(s)`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else console.log('mcp tool name lint passed: no dead MCP server names in .claude sources or generated mirrors');
