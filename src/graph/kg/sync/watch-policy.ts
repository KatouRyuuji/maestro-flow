// src/graph/kg/sync/watch-policy.ts — WSL2 监听策略 + Git 钩子
// 参考: plan-maestrograph.md Gap 修补 9

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// WSL2 检测
// ---------------------------------------------------------------------------

/**
 * 检测是否在 WSL2 环境中运行
 * /mnt/* 路径 → drvfs 文件系统, recursive watch 性能极差
 */
export function isWSL2(): boolean {
  if (process.platform !== 'linux') return false;

  // 检查 /proc/version 是否包含 Microsoft/WSL
  try {
    const { readFileSync } = require('node:fs');
    const version = readFileSync('/proc/version', 'utf-8');
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

/**
 * 检测当前工作目录是否在 drvfs 挂载点上
 * /mnt/c, /mnt/d 等路径应禁用 recursive watch
 */
export function isOnDrvFs(projectPath: string): boolean {
  const normalized = resolve(projectPath);
  return /^\/mnt\/[a-z]\//i.test(normalized);
}

// ---------------------------------------------------------------------------
// Watch 策略决策
// ---------------------------------------------------------------------------

export interface WatchStrategy {
  /** 是否可以使用 recursive watch */
  canUseRecursiveWatch: boolean;
  /** 是否应使用 git hooks 作为替代 */
  useGitHooks: boolean;
  /** 原因说明 */
  reason: string;
}

/**
 * 决定文件监听策略
 *
 * 策略优先级:
 * 1. 正常文件系统 → recursive watch
 * 2. WSL2 drvfs → git hooks 替代
 * 3. 不支持 → 手动同步
 */
export function decideWatchStrategy(projectPath: string): WatchStrategy {
  if (isWSL2() && isOnDrvFs(projectPath)) {
    return {
      canUseRecursiveWatch: false,
      useGitHooks: true,
      reason: 'WSL2 drvfs detected — recursive watch would block MCP handshake. Using git hooks instead.',
    };
  }

  if (isWSL2()) {
    return {
      canUseRecursiveWatch: true,
      useGitHooks: false,
      reason: 'WSL2 with native filesystem — recursive watch available but may be slower.',
    };
  }

  return {
    canUseRecursiveWatch: true,
    useGitHooks: false,
    reason: 'Native filesystem — recursive watch available.',
  };
}

// ---------------------------------------------------------------------------
// Git hooks 安装 (WSL2 替代方案)
// ---------------------------------------------------------------------------

export const GIT_HOOK_SCRIPT = `#!/bin/sh
# MaestroGraph incremental sync — triggered by git hooks
# Install: ln -sf ../../.workflow/kg/hooks/post-commit .git/hooks/post-commit

MAESTRO_ROOT="$(git rev-parse --show-toplevel)"
if [ -f "$MAESTRO_ROOT/.workflow/kg/maestro.db" ]; then
  cd "$MAESTRO_ROOT" && npx maestro kg sync --incremental >>"$MAESTRO_ROOT/.workflow/kg/sync-hook.log" 2>&1 || true
fi
`;

/**
 * 检查 git hooks 是否已安装
 */
export function areGitHooksInstalled(projectPath: string): boolean {
  const hookPath = resolve(projectPath, '.git', 'hooks', 'post-commit');
  if (!existsSync(hookPath)) return false;

  try {
    const { readFileSync } = require('node:fs');
    const content = readFileSync(hookPath, 'utf-8');
    return content.includes('MaestroGraph');
  } catch {
    return false;
  }
}