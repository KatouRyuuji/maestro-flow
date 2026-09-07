import type { TargetPlatform } from '../core/skill-converter.js';

export type GoalMode = { platform: string; instructions: string };

/**
 * Goal 模式 — prepare frontmatter 声明 `goal: true` 的 step，加载时按平台附带
 * 该宿主原生 Goal 提示。Maestro 不改 Goal 行为：设定、暂停、继续、清除都跟宿主走。
 */
export const GOAL_MODE_BLOCKS: Partial<Record<TargetPlatform, string>> = {
  claude: [
    'Goal 跟 Claude Code 原生 /goal 走。Maestro 不改 Goal 行为。',
    '1. 可提示用户复制 /goal 设定终止条件（非阻塞）：',
    '   /goal 完成以下子目标：',
    '   {逐条列出 decomposition.goals 中 status!=superseded 的 id: goal — 完成条件: done_when}',
    '2. 用户输入 /goal 后由 Claude Code 管理。LLM 不要重建 Goal。',
    '3. 用户未输入 /goal，不影响执行。',
    '4. 用户清除或关闭 /goal 后：不要再输出 /goal，不要重建。外观必须保持消失。',
  ].join('\n'),
  codex: [
    'Goal 模式（该 step 声明 goal 标志）：',
    '1. Session 创建后 call `create_goal({ objective: "{intent}", success_criteria: [decomposition.goals 各 done_when] })`；单一活跃 goal，若已有未完成 goal 先收口。',
    '2. 过程中可用 `get_goal({})` 查看进度与剩余 token 预算。',
    '3. 全部子目标完成时 `update_goal({ status: "complete" })`；阻塞时 `update_goal({ status: "blocked" })`。',
    '4. 完成后向用户报告最终状态。',
  ].join('\n'),
  pi: [
    'Goal 模式（该 step 声明 goal 标志）：',
    '1. Session 创建后 call `goal({ action: "create", objective: "{intent}" })`。',
    '2. 过程中可用 `goal({ action: "get" })` 查看状态。',
    '3. 全部子目标完成时 `goal({ action: "complete", summary: "..." })`。',
  ].join('\n'),
  'agents-standard': [
    'Goal 模式（该 step 声明 goal 标志）：',
    '1. Session 创建后 call `create_task({ subject: "Session: {intent}", description: "完成条件: {decomposition.goals 各 done_when 汇总}" })` 作为 session goal。',
    '2. 各子目标完成时 update_task 标记 completed。',
    '3. 全部完成时 update_task session goal 为 completed。',
  ].join('\n'),
  grok: [
    'Goal 跟 Grok 原生 /goal 走：/goal <objective>、/goal status、/goal pause、/goal resume、/goal clear。Maestro 不改 Goal 行为。',
    '1. 只有用户已经用 /goal 武装过时，才用 create_goal / update_goal / get_goal。',
    '2. 全部完成时 update_goal({ status: "complete" })。',
    '3. 用户 /goal clear 或 pause 后：不要再 create_goal / update_goal。外观必须保持消失。',
  ].join('\n'),
  cursor: [
    'Goal 跟 Cursor 原生 /goal 走。Maestro 不改 Goal 行为。',
    '1. 只有用户输入 /goal <objective> 或明确要求时，才 CreateGoal({ objective }) 一次。',
    '2. UpdateGoal({ status: "complete" }) 只在目标真正完成时调用。',
    '3. UpdateGoal({ status: "active" }) 只在用户暂停后要求继续时调用。',
    '4. 用户清除或关闭 Goal 后：不要 CreateGoal，不要 UpdateGoal。外观必须保持消失。',
    '5. 不要用 UpdateGoal 刷新外观。不要把 TaskCreate 当成 Goal。',
  ].join('\n'),
};

export function extractGoalFlag(raw: string): boolean {
  const fm = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  return /^goal:\s*true\s*$/m.test(fm[1]);
}

export function resolveGoalMode(
  prepareRaw: string | undefined,
  platform: TargetPlatform,
): GoalMode | null {
  if (!prepareRaw || !extractGoalFlag(prepareRaw)) return null;
  const block = GOAL_MODE_BLOCKS[platform];
  return block ? { platform, instructions: block } : null;
}

const KNOWN_PLATFORMS = new Set<TargetPlatform>([
  'claude', 'codex', 'agy', 'agents-standard', 'pi', 'grok', 'cursor',
]);

function asTargetPlatform(value: string | undefined): TargetPlatform | null {
  if (!value) return null;
  return KNOWN_PLATFORMS.has(value as TargetPlatform) ? value as TargetPlatform : null;
}

/**
 * Decide which Goal-UI instruction set to emit.
 *
 * `MAESTRO_PLATFORM` is an explicit override (tests and machine callers).
 * `CURSOR_AGENT=1` means the host is Cursor — emit Cursor-native /goal
 * instructions, not Claude's /goal paste prompt.
 * Do not use this helper to persist `resolved_platform` on a Run.
 */
export function inferGoalUiPlatform(
  resolvedPlatform: TargetPlatform,
  env: NodeJS.Dict<string | undefined> = process.env,
): TargetPlatform {
  const override = asTargetPlatform(env.MAESTRO_PLATFORM);
  if (override) return override;
  if (env.CURSOR_AGENT === '1') return 'cursor';
  return resolvedPlatform;
}

/** Host-aware Goal instructions: Cursor agent gets Cursor-native /goal rules. */
export function resolveGoalModeForHost(
  prepareRaw: string | undefined,
  resolvedPlatform: TargetPlatform,
  env: NodeJS.Dict<string | undefined> = process.env,
): GoalMode | null {
  return resolveGoalMode(prepareRaw, inferGoalUiPlatform(resolvedPlatform, env));
}
