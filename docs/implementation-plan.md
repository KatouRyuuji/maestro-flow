# 统一实施规划：Session/Run 职责分离 + Ralph 迁移

> 权威参考：[conflict-resolution.md](./conflict-resolution.md)
> 本文档列出所有需修改的文件及具体变更内容。

---

## 一、变更总览

| 类别 | 文件数 | 说明 |
|---|---|---|
| 代码（src/） | ~12 | session 命令面提升、run 精简、graph 新增、ralph 删除 |
| Agent 定义 | 4 | run-executor × 2 镜像、ralph-executor × 2 镜像 |
| Workflow 文件 | 4 | run-mode、orchestrator-run-loop、run-mode-lite、ralph-amend-goal |
| Skill 文件 | 1 | maestro-ralph SKILL.md |
| 文档（docs/） | 6 | 已修正（5 份 + conflict-resolution） |

---

## 二、代码变更（src/）

### 2.1 `src/commands/session.ts` — 提升为主命令面

**变更**:

1. 取消 `hidden: true`：
```typescript
// 当前
.command('session', { hidden: true })
// 改为
.command('session')
```

2. 新增子命令（从 run.ts 迁移注册）：

```typescript
// 新增 session next
session.command('next')
  .description('Advance chain: create next pending Run, emit birth packet')
  .option('--session <id>', 'Session ID')
  .option('--inline-brief', 'Include brief-level guidance in the response')
  .option('--pick <step-id>', 'Advance a specific pending step')
  .option('--json', 'Structured JSON output')
  // ... lease options
  .action(...)  // 调用 runNextStep() + 可选 briefRun()

// 新增 session done
session.command('done [run-id]')
  .description('Complete a Run step and advance the chain')
  .option('--session <id>')
  .option('--verdict <verdict>', 'done|done-with-concerns|needs-retry|blocked')
  .option('--summary <text>')
  .option('--check-clean', 'Skip re-scan (executor confirmed check passed)')
  // ... note/decision/evidence options
  .action(...)  // 调用 completeRunWithVerdict()

// 新增 session decide
session.command('decide <point-id>')
  .description('Adjudicate a decision node')
  // ... 从 run.ts 迁移

// 新增 session graph
session.command('graph [session-id]')
  .description('Show chain visualization with steps, decisions, goals')
  .option('--json')
  .action(...)  // 调用新建的 buildGraph()

// 新增 session recover（从 run.ts 迁移）
// 新增 session status（合并 run status）
// 新增 session seal（合并 run seal-session）
// 新增 session edit（合并 run edit → session chain edit）
```

3. 保留已有子命令：create, list, show, check, evidence, chain, meta, migrate, resolve, resume

### 2.2 `src/commands/run.ts` — 精简为执行器命令面

**变更**:

1. 保留的子命令（Run 级）：
   - `run brief` — 回溯/re-attach（正常流程不调）
   - `run check` — gate 检查 + finish 注入
   - `run create` — 独立 Run 创建
   - `run prepare` — 预读/规划
   - `run skill` — 一次性执行
   - `run complete` — 底层完成（session done 内部调用）
   - `run rebind` — prompt drift 重绑定
   - `run accept-reuse` — 复用评估接受
   - `run recall` — 历史回忆

2. 改为 deprecated alias 的子命令（Session 级）：
   - `run next` → stderr 警告 + 转发到 session next
   - `run start` → stderr 警告 + 转发到 session create
   - `run done` → stderr 警告 + 转发到 session done
   - `run status` → stderr 警告 + 转发到 session status
   - `run decide` → stderr 警告 + 转发到 session decide
   - `run seal-session` → stderr 警告 + 转发到 session seal
   - `run recover` → stderr 警告 + 转发到 session recover
   - `run edit` → stderr 警告 + 转发到 session chain edit

3. `run next` 增加 `--inline-brief` 支持（在 session next 中实现）：
```typescript
// run/next.ts runNextStep() 返回 NextResult 后
// 如果 opts.inlineBrief，追加调用 briefRun() 并合入结果
```

### 2.3 `src/run/graph.ts` — 新建

```typescript
// ~150 行
export interface GraphResult {
  session_id: string;
  intent: string;
  status: string;
  engine: string;
  quality_mode: string;
  progress: { sealed: number; running: number; pending: number; total: number };
  chain: Array<{
    index: number; step_id: string; command: string;
    status: string; run_id: string | null;
    decision_ref: string | null; active: boolean;
  }>;
  decisions: Array<{
    point_id: string; status: string; after_step_id: string | null;
    retry_count: number; max_retries: number;
  }>;
  goals: Array<{ id: string; goal: string; status: string; done_when?: string }>;
  position: { lifecycle: string; phase: number | null; milestone: string } | null;
  continuation: { action: string; command: string | null };
}

export function buildGraph(projectRoot: string, sessionId?: string): GraphResult { ... }
export function renderGraphHuman(graph: GraphResult): string { ... }
```

### 2.4 `src/run/next.ts` — 增加 inline-brief

```typescript
// NextResult 增加可选 brief 字段
export interface NextResult {
  // ... 现有字段
  brief?: BriefRunResult;  // --inline-brief 时填充
}

// runNextStep 增加 inlineBrief 选项
export function runNextStep(projectRoot, opts: NextCmdOptions & { inlineBrief?: boolean }): NextOutcome {
  // ... 现有逻辑
  if (opts.inlineBrief && result) {
    result.brief = briefRun(projectRoot, result.run_id, sessionId, platform);
  }
}
```

### 2.5 `src/run/runtime.ts` — done 跳过重扫

```typescript
// completeRun 增加 checkClean 选项
export interface CompleteRunOptions {
  // ... 现有
  checkClean?: boolean;  // 跳过 scanOutputs + evaluateRunGates
}

// applyCompleteRunMutation 中：
if (options.checkClean && checkCleanValid(runDir)) {
  // 跳过 scanOutputs，使用上次 check 的 gate 结果
  // 验证 .check_clean 标记时间戳 > outputs/ 最新 mtime
}
```

### 2.6 `src/run/contract.ts` — 进程级缓存

```typescript
const contentCache = new Map<string, ResolvedStepContent>();
const sourceCache = new Map<string, ResolvedCommandSource>();

export function resolveStepContent(projectRoot, stepName, platformSuffix?) {
  const key = `${projectRoot}:${stepName}:${platformSuffix ?? ''}`;
  let cached = contentCache.get(key);
  if (!cached) {
    cached = resolveStepContentUncached(projectRoot, stepName, platformSuffix);
    contentCache.set(key, cached);
  }
  return cached;
}
// resolveCommandSource 同理
```

### 2.7 `src/run/session-resolver.ts` — 多 Session 解析

```typescript
export function resolveCompatibleSession(projectRoot, sessionId?, opts?) {
  // 1. 显式 --session
  if (sessionId) return directRead(sessionId);
  // 2. 环境变量
  const envId = process.env.MAESTRO_SESSION_ID;
  if (envId && store.sessionExists(envId)) return directRead(envId);
  // 3. state.json sessions 列表中唯一 running
  const state = readStateJson(projectRoot);
  const running = (state?.sessions ?? []).filter(s => s.status === 'running');
  if (running.length === 1) return directRead(running[0].session_id);
  if (running.length > 1) return ambiguous(running);  // 报错
  // 4. 全量扫描 fallback
  return scanAll();
}
```

### 2.8 `src/ralph/` — 删除

| 文件 | 处置 |
|---|---|
| cmd-next.ts (417行) | 删除 |
| cmd-complete.ts (206行) | 删除 |
| cmd-check.ts (69行) | 删除 |
| cmd-session.ts (75行) | 删除 |
| cmd-ledger.ts (164行) | 删除 |
| cmd-skills.ts (2行) | 删除 |
| skill-resolver.ts (2行) | 删除 |
| skill-scanner.ts (2行) | 删除 |
| status-store.ts (52行) | 删除 |
| status-checker.ts (18行) | 删除 |
| session-adapter.ts (449行) | 拆分：effectivePosition/Decomposition/Lease → `run/orchestration-readers.ts`；resolveRalphSession → `run/session-resolver.ts`；createRalphSession → `run/chain-admin.ts`；readMeta → `run/migrate.ts` |
| status-schema.ts (159行) | 合入 `run/schemas.ts`（部分已在） |
| verification-ledger.ts (94行) | 合入 `run/` 或标记 legacy |
| 测试文件 | 迁移到对应 run/ 模块 |

### 2.9 `src/commands/ralph.ts` — 删除

从 `src/cli.ts` 移除 `registerRalphCommand` 调用。

### 2.10 `src/hooks/` — 清理 ralph 分支

- `coordinator-tracker.ts`: `source === 'ralph'` → 统一 `engine` 判断
- `statusline.ts`: `isRalph` 分支合并
- `skill-context.ts`: `/maestro-ralph` pattern 保留（SKILL.md 仍存在）

### 2.11 `src/utils/state-schema.ts` — sessions 列表增加 last_activity

```typescript
interface ProjectSessionEntry {
  session_id: string;
  intent: string;
  status: string;
  last_activity?: string;  // 新增 ISO 时间戳
  // ...
}
```

---

## 三、Agent 定义变更

### 3.1 `.claude/agents/run-executor.md` + `.agents/agents/run-executor.md`

**当前问题**: 正常流程中调 `run brief` 和 `run next`

**修改**:

```markdown
## Process

1. Resolve the Run：
   - dispatch prompt 含 inline brief 数据 → 直接使用，**不调 run brief**
   - dispatch prompt 仅含 run_id（无 brief）→ `maestro run brief {run_id} --session {session_id}`（回溯路径）
   - dispatch prompt 仅含 session_id（无 run_id）→ `maestro session next --session {session_id} --inline-brief --json`
     - Exit 0 → 从 JSON 提取 run_id + brief 数据，执行
     - Exit 2 → 所有 step 已完成 / decision 节点
     - Exit 3 → 当前步已 running → `maestro run brief {run_id}` re-attach

2. Execute the skill prompt inline（从 brief 数据或 inline-brief）

3. Handle refs: Read files on demand

4. Run pre-completion check：`maestro run check {run_id} --session {session_id}`
   - clean → 执行 finish checklist → 返回
   - blocking → 修复 → 重新 check（≤2 轮）

5. 返回 run_id + check 状态 + 产物路径 + 摘要
```

**删除**:
- 对 `maestro run next` 的调用（改为 `maestro session next`）
- 对 `maestro ralph` 的任何引用

### 3.2 `.claude/agents/ralph-executor.md` + `.agents/agents/ralph-executor.md`

**当前**: 已标记为 deprecated alias，委托到 run-executor

**修改**: 保持不变（已是兼容 alias），或标记删除日期

---

## 四、Workflow 文件变更

### 4.1 `workflows/run-mode.md`

**需修改的行**:

| 行 | 当前 | 改为 |
|---|---|---|
| 26 | "When `maestro run next` invokes you" | "When `maestro session next` invokes you" |
| 71 | "Accept calls `maestro run done ... --apply-proposal`" | "Accept calls `maestro session done ... --apply-proposal`" |
| 79 | "Run `maestro run done {run_id}`" | "Run `maestro session done {run_id} --session {session_id}`" |
| 79 | "`maestro run complete {run_id}` remains..." | "`maestro run complete {run_id}` remains the machine-compatible spelling" |
| 82 | "`maestro run next --session {session_id}`" | "`maestro session next --session {session_id}`" |
| 82 | "`run next` is the sole normal allocator" | "`session next` is the sole normal allocator" |

**新增段落**（Prepare 章节后）:

```markdown
## Inline Brief (orchestrator-dispatched)

When dispatched by an orchestrator via `maestro session next --inline-brief --json`,
the birth packet includes the full Resume Packet inline — guidance, execution contract,
and continuity context. The executor uses this data directly and does NOT call
`maestro run brief` in the normal forward flow.

`maestro run brief <run_id>` remains available for **re-attach/backtracking**:
executor crash recovery, context window overflow, or manual Run inspection.
```

### 4.2 `workflows/orchestrator-run-loop.md`

**需修改的行**:

| 行 | 当前 | 改为 |
|---|---|---|
| 88 | "`maestro run next --session {session_id} --json`" | "`maestro session next --session {session_id} --inline-brief --json`" |
| 121 | "`maestro run done {run_id} --session {session_id} --verdict ...`" | "`maestro session done {run_id} --session {session_id} --verdict ...`" |
| 141 | "`maestro run decide {point_id} --session {session_id} ...`" | "`maestro session decide {point_id} --session {session_id} ...`" |
| 160 | "`maestro run seal-session {session_id} --summary ...`" | "`maestro session seal {session_id} --summary ...`" |

**Continuation Router 表更新**:

| action | 当前 | 改为 |
|---|---|---|
| `dispatch_next` | "`run next --json`" | "`session next --inline-brief --json`" |
| `load_run` | "`run brief --json`" | "`run brief --json`（仅回溯）" |
| `seal_session` | "`run seal-session`" | "`session seal`" |

**新增**: `session graph` 在循环入口可选调用

### 4.3 `workflows/run-mode-lite.md`

| 行 | 当前 | 改为 |
|---|---|---|
| 8 | "birth packet from `maestro run next`" | "birth packet from `maestro session next`" |
| 36 | "Run `maestro run done <run_id>`" | "Run `maestro session done <run_id> --session <session_id>`" |

### 4.4 `workflows/ralph-amend-goal.md`

| 行 | 当前 | 改为 |
|---|---|---|
| 66 | "`maestro run status`" | "`maestro session status`" |
| 66 | "`maestro run next`" | "`maestro session next`" |

### 4.5 `workflows/codex-run-mode.md`

| 行 | 当前 | 改为 |
|---|---|---|
| 25 | "`maestro run check {run_id}` and `maestro run done {run_id}`" | "`maestro run check {run_id}` and `maestro session done {run_id} --session {session_id}`" |

---

## 五、Skill 文件变更

### 5.1 `.agents/skills/maestro-ralph/SKILL.md`

**需修改**:

1. `<required_reading>` 保持不变（run-mode.md + orchestrator-run-loop.md）

2. `<purpose>` 更新：
```
Apply retry, confidence, drift, goal-audit and stopping policy over any compatible
canonical Session. Ralph calls only `maestro session ...` and `maestro run ...`
following the shared Run loop.
```

3. `<invariants>` 更新：
```
6. **Runtime mutation authority** — normal flow uses only `maestro session ...`
   and `maestro run ...`.
```

4. `<actions>` 全面更新：

**A_RESOLVE**: 不变（`maestro run recall` 是 Run 级，保留）

**A_CREATE**:
```
maestro session create "{intent}" --id {slug} --chain-file {path}
```
（当前用 `maestro run start`，改为 `maestro session create`）

**A_EXECUTE**（核心变更）:
```
Follow orchestrator-run-loop.md exactly.

Loop:
  1. maestro session next --session {id} --inline-brief --json
     → { run_id, step, queue, brief: { guidance, contract, continuity } }
  2. dispatch run-executor(session_id, run_id, brief_data)
     → executor 从 brief_data 执行，run check，finish work，返回
  3. maestro session done {run_id} --session {id} --verdict {v} --json
     → { continuation }
  4. continuation.action:
     "next"   → 回到 1
     "decide" → session decide → continuation
     "seal"   → session seal
```

**A_EVALUATE**:
```
maestro session decide {point_id} --session {id} --verdict ... --json
```
（当前用 `maestro run decide`）

**A_RECOVER**:
```
maestro session status → maestro session recover
```
（当前用 `run status` / `run recover`）

**A_AMEND**:
```
maestro session status → ... → maestro session next
```
（当前用 `run status` / `run next`）

**A_DONE**:
```
maestro session seal {session_id} --summary "..."
```
（当前用 `maestro run seal-session`）

5. `<success_criteria>` 更新：
```
- Each Run follows session next → execute → run check → session done
  and every decision uses session decide.
```

---

## 六、实施顺序

```
Phase 1: 基础设施（无破坏）
  ├─ 1a. src/run/graph.ts 新建
  ├─ 1b. src/run/contract.ts 缓存
  ├─ 1c. src/run/session-resolver.ts 多 Session
  ├─ 1d. src/utils/state-schema.ts last_activity
  └─ 1e. src/run/next.ts --inline-brief 支持

Phase 2: 命令面重构
  ├─ 2a. src/commands/session.ts 提升 + 新增 next/done/decide/graph/seal
  ├─ 2b. src/commands/run.ts 精简 + deprecated alias
  └─ 2c. src/run/runtime.ts done 跳过重扫

Phase 3: Prompt 层切换
  ├─ 3a. workflows/run-mode.md 更新
  ├─ 3b. workflows/orchestrator-run-loop.md 更新
  ├─ 3c. workflows/run-mode-lite.md + codex-run-mode.md + ralph-amend-goal.md
  ├─ 3d. .agents/skills/maestro-ralph/SKILL.md 更新
  └─ 3e. .claude/agents/run-executor.md + .agents/agents/run-executor.md 更新

Phase 4: Ralph 删除
  ├─ 4a. session-adapter.ts 拆分合入 run/
  ├─ 4b. 删除 src/ralph/ 目录
  ├─ 4c. 删除 src/commands/ralph.ts + cli.ts 引用
  └─ 4d. hooks 清理

Phase 5: 验证
  ├─ 5a. 现有测试迁移 + 通过
  ├─ 5b. 端到端测试：session create → next → check → done → seal
  └─ 5c. 多 Session 并行测试
```

---

## 七、完整文件变更清单

| 文件 | 操作 | Phase |
|---|---|---|
| `src/run/graph.ts` | **新建** | 1 |
| `src/run/contract.ts` | 修改（缓存） | 1 |
| `src/run/session-resolver.ts` | 修改（多 Session） | 1 |
| `src/run/next.ts` | 修改（--inline-brief） | 1 |
| `src/utils/state-schema.ts` | 修改（last_activity） | 1 |
| `src/commands/session.ts` | **大改**（提升 + 新增子命令） | 2 |
| `src/commands/run.ts` | **大改**（精简 + alias） | 2 |
| `src/run/runtime.ts` | 修改（done 跳过重扫） | 2 |
| `src/run/orchestration-readers.ts` | **新建**（从 session-adapter 合入） | 4 |
| `workflows/run-mode.md` | 修改（命令引用） | 3 |
| `workflows/orchestrator-run-loop.md` | 修改（命令引用） | 3 |
| `workflows/run-mode-lite.md` | 修改（命令引用） | 3 |
| `workflows/codex-run-mode.md` | 修改（命令引用） | 3 |
| `workflows/ralph-amend-goal.md` | 修改（命令引用） | 3 |
| `.agents/skills/maestro-ralph/SKILL.md` | **大改**（命令 + 流程） | 3 |
| `.claude/agents/run-executor.md` | 修改（流程） | 3 |
| `.agents/agents/run-executor.md` | 修改（流程） | 3 |
| `.claude/agents/ralph-executor.md` | 保持/标记删除 | 4 |
| `.agents/agents/ralph-executor.md` | 保持/标记删除 | 4 |
| `src/ralph/*.ts` (13 文件) | **删除** | 4 |
| `src/commands/ralph.ts` | **删除** | 4 |
| `src/cli.ts` | 修改（移除 ralph 注册） | 4 |
| `src/hooks/coordinator-tracker.ts` | 修改（清理 ralph 分支） | 4 |
| `src/hooks/statusline.ts` | 修改（清理 ralph 分支） | 4 |
| `docs/*.md` (6 文件) | ✅ 已修正 | — |
