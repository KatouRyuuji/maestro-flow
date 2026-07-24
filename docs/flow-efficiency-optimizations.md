# 流程高效流转优化清单

> ⚠️ **本文档已被 [conflict-resolution.md](./conflict-resolution.md) 修正。以下为修正要点：**
> - O1：~~合并 check + done~~ → **不合并**（check 是 finish checklist 注入点），done 通过 `.check_clean` 标记跳过重扫
> - O2：`session next --inline-brief` 为正常流程，**brief 仅回溯用**
> - O3：~~active_session_id 单数快速路径~~ → **多 Session 解析**（显式 --session > 环境变量 > 唯一 running > 报错）
> - 目标链路：~~3 次 CLI（next+brief+done）~~ → **3 次 CLI（next+check+done）**
> - 命令命名空间：`run next/done` → **`session next/done`**
>
> 实施时以 conflict-resolution.md 的「统一后权威流程」为准。

> 聚焦：减少 CLI 往返、消除重复 I/O、统一 Coordinator/Ralph 双轨、
> 让 Session/Run 命令面适配所有编排器（Ralph、Coordinator、人类）。

---

## 一、每步执行的 CLI 开销分析

### 当前每步完整链路（Ralph 路径）

```
编排器 shell 调用                          进程数   磁盘 I/O
─────────────────────────────────────────────────────────────
1. maestro ralph next --session X           1      session.json + ralph-meta + 4×.md解析
   └─ 内部: runNextStep → createRun                + run.json写入 + chain更新
2. executor: maestro run brief {run_id}     1      session.json + run.json + 4×.md解析
   └─ 内部: resolveStepContent × 1                 + contract解析 + anchor重建
        contractForRun → resolveCommandSource × 1
        revalidateRunReuse
        buildAnchorSections
3. executor: 执行 skill（实际工作）
4. executor: maestro run check {run_id}     1      session.json + run.json + outputs/扫描
   └─ 内部: scanOutputs + evaluateRunGates         + gate评估
5. 编排器: maestro run done {run_id}        1      session.json + run.json + outputs/再扫描
   └─ 内部: completeRun → scanOutputs(再次!)       + gate再评估 + handoff派生
        evaluateRunGates(再次!)                     + chain推进 + continuation
─────────────────────────────────────────────────────────────
合计: 4 次 CLI 进程启动 + ~12 次 session.json 读取 + 2 次 outputs 扫描
```

### 目标链路（Session/Run 分离后）

```
1. maestro session next --session X --json  1      session.json + 1×.md(缓存)
   → { run_id, step, queue }                       + run.json写入
2. executor: maestro run brief {run_id}     1      session.json + run.json + 1×.md(缓存命中)
   → { guidance, contract, continuity }
3. 执行 skill
4. maestro session done {run_id} --json     1      session.json + run.json + outputs/扫描(1次)
   → { continuation }                              + gate评估(1次) + chain推进
─────────────────────────────────────────────────────────────
合计: 3 次 CLI + ~6 次 session.json + 1 次 outputs 扫描
```

**节省: 1 次 CLI 往返 + 6 次 session.json 读取 + 1 次 outputs 扫描 + 3 次 .md 解析**

---

## 二、10 项流程优化

### O1: 消除 check→done 双重扫描（最高 ROI）

**问题**: executor 调 `run check`（scanOutputs + evaluateRunGates），然后编排器调 `session done`（内部 completeRun 再次 scanOutputs + evaluateRunGates）。同一份 outputs/ 被扫描两次，同一组 gates 被评估两次。

**方案**: `session done` 接受 `--check-clean` 标志，表示 executor 已确认 check 通过。
done 内部跳过 scanOutputs，仅验证 check 时间戳 > 最后文件修改时间。

```bash
# executor 完成 check 后记录时间戳
maestro run check {run_id} --session X  # → 写入 .check_timestamp
# 编排器 done 时跳过重扫
maestro session done {run_id} --check-clean --verdict done --json
```

**或者更彻底**: 合并 check + done 为一步：

```bash
maestro session done {run_id} --verdict done --json
# 内部: 如果 gates 未通过 → 返回 { sealed: false, gates: {...} }
# 如果 gates 通过 → 直接 seal + continuation
# executor 不需要单独调 check
```

**预估节省**: 每步减少 1 次 CLI 调用 + 1 次 outputs 扫描（~50-200ms）

---

### O2: `session next` 内联 brief（--inline-brief）

**问题**: `session next` 创建 Run 后返回指针，executor 再调 `run brief` 获取正文。两次 CLI 往返。

**方案**: `session next --inline-brief --json` 在 birth packet 中直接包含 brief 级数据：

```json
{
  "run_id": "...",
  "step": { "index": 2, "command": "execute", "total": 5 },
  "queue": [...],
  "brief": {
    "guidance": { "prepare": {...}, "workflow": {...}, "refs": [...] },
    "execution_contract": { "inputs": [...], "outputs": {...}, "gates": {...} },
    "continuity": { "prev_handoff": {...}, "anchor": {...} }
  }
}
```

executor 收到 dispatch prompt 时直接拿到正文，无需再调 `run brief`。
`run brief` 保留用于 re-attach（executor 重启/上下文丢失时）。

**预估节省**: 每步减少 1 次 CLI 往返（~200-500ms 进程启动）

**注意**: workflow 正文可能很大（>10KB），JSON 体积需评估。可设为 opt-in。

---

### O3: Session 解析缓存（active_session_id 快速路径）

**问题**: 每个 CLI 命令都重新扫描 `.workflow/sessions/` 目录寻找目标 Session。
`resolveCompatibleSession` → `store.listSessions` → `readdirSync` + 逐个 `readBundle`。

**方案**: `state.json` 已有 `active_session_id` 字段。优先走快速路径：

```typescript
// session-resolver.ts
function resolveCompatibleSession(projectRoot, sessionId?) {
  if (sessionId) return directRead(sessionId);  // 已有
  const state = readStateJson(projectRoot);
  if (state?.active_session_id) {
    const session = directRead(state.active_session_id);
    if (session && isCompatible(session)) return session;  // 快速路径
  }
  return scanAllSessions();  // 慢路径 fallback
}
```

**预估节省**: 每次 Session 解析从 ~5-15ms（目录扫描）降到 ~1ms（直接读取）

---

### O4: resolveStepContent 进程级缓存

**问题**: 同一命令的 .md 文件在一次 next→brief→done 链路中被解析 4 次
（每次都是 readFileSync + YAML.parse + sha256）。

**方案**: 在 `contract.ts` 增加模块级缓存：

```typescript
const contentCache = new Map<string, ResolvedStepContent>();

export function resolveStepContent(projectRoot, stepName, platformSuffix?) {
  const key = `${projectRoot}:${stepName}:${platformSuffix ?? ''}`;
  const cached = contentCache.get(key);
  if (cached) return cached;
  const result = resolveStepContentUncached(projectRoot, stepName, platformSuffix);
  contentCache.set(key, result);
  return result;
}
```

CLI 进程是短生命周期的，缓存只在单次调用内有效。
但 `run next` 内部调用 `resolveStepContent`（验证）+ `createRun` → `resolveCommandSource`（contract），
同一进程内可命中。`run brief` 是另一个进程，无法跨进程缓存。

**进阶**: 如果实现 O2（inline-brief），next 和 brief 在同一进程内，缓存命中率 100%。

**预估节省**: 每次链路减少 2-3 次文件读取 + YAML 解析（~10-30ms）

---

### O5: Continuation 富化（done 返回下一步 birth info）

**问题**: `session done` 返回 continuation `{ action: "next", command: "session next" }`，
编排器需要再调一次 `session next` 获取下一步的 run_id 和 step info。

**方案**: done 的 continuation 直接携带下一步的 birth info：

```json
{
  "continuation": {
    "action": "next",
    "command": "maestro session next --session X",
    "next_step": {
      "index": 3,
      "command": "review",
      "step_id": "S004",
      "decision_ref": null
    }
  }
}
```

编排器拿到 continuation 后，如果 `action === "next"` 且 `next_step` 存在，
可以直接 dispatch executor（executor 内部调 `session next` 创建 Run）。
或者更激进：done 内部原子推进到下一步（创建 Run），返回 run_id。

**预估节省**: 编排器决策延迟减少（不需要解析 continuation 再构造下一个命令）

---

### O6: Coordinator 迁移到 Session/Run（消除双轨）

**问题**: Coordinator（graph-walker）是完全独立的平行系统：
- 自己的 session 管理（`coord-{timestamp}` ID，JSON 文件持久化）
- 自己的 prompt 组装（prompt-assembler.ts，不复用 inject.ts）
- 自己的状态机（WalkerState，不用 SessionState）
- 自己的执行器（cli-executor.ts，不走 run brief/check/done）

**方案**: 分阶段迁移：

**Phase 1**: Coordinator 的 graph 定义映射到 Session chain：
```
ChainGraph nodes → session.orchestration.chain steps
CommandNode → execution step
DecisionNode → decision step
GateNode → entry/exit gates
ForkNode/JoinNode → 未来并行步骤（当前不支持，标记为 sequential）
```

**Phase 2**: Coordinator 的 execute 路径走 Session/Run：
```
graph-walker.executeCommand()
  → session next (创建 Run)
  → run brief (获取正文)
  → executor 执行
  → session done (完成 + continuation)
```

**Phase 3**: prompt-assembler 复用 inject.ts builder，删除平行实现。

**预估节省**: 消除 ~1500 行平行代码（graph-walker + prompt-assembler + cli-executor），
统一维护面，所有编排器共享 Session/Run 的 gate/artifact/handoff 基础设施。

---

### O7: Hook 状态读取优化

**问题**: `coordinator-tracker.ts`（statusline hook）在每次状态栏刷新时：
- `readdirSync(.workflow/sessions/)` 扫描所有 session 目录
- 逐个 `readFileSync(session.json)` 解析
- 可能还读 `ralph-meta.json` fallback
- 读 `state.json`
- 读 maestro status 文件

**方案**:
1. **TTL 缓存**: hook 读取结果缓存 2-5 秒，避免每次刷新都扫磁盘
2. **active_session_id 快速路径**: 只读 `state.json` → `active_session_id` → 单个 session.json
3. **inotify/FSWatcher**: 监听 session.json 变更，而非轮询（长期）

**预估节省**: statusline 刷新从 ~10-30ms 降到 ~1ms

---

### O8: `run prepare` 与 `run brief` 职责明确化

**问题**: 当前 prepare 返回 prepare 全文 + workflow **行数**（非正文）+ run-mode 摘要。
定位模糊：编排器不知道什么时候用 prepare，什么时候用 brief。

**方案**: 明确分工：

| | `run prepare` | `run brief` |
|---|---|---|
| 时机 | Run 创建**前** | Run 创建**后** |
| 状态 | read-only, stateless | 绑定 run_id |
| 用途 | 编排器预读/规划/构建链 | executor 获取执行正文 |
| prepare 内容 | ✅ 全文 | ✅ 全文 |
| workflow 内容 | 摘要（前 10 行 + frontmatter） | ✅ 全文 |
| contract | ❌ | ✅ 完整 |
| upstream | ❌ | ✅ 已解析 |
| anchor | ❌ | ✅ 完整 |
| session guidance | ✅（--session 时） | ❌（已在 anchor 中） |

**调整**: prepare 的 `workflow.line_count` 改为 `workflow.summary`（前 10 行）。

---

### O9: 统一 `session done` 的 verdict 映射

**问题**: Ralph 用 `DONE | DONE_WITH_CONCERNS | NEEDS_RETRY | BLOCKED`（大写），
Run 用 `done | done-with-concerns | needs-retry | blocked`（小写连字符）。
两套映射增加认知负担。

**方案**: `session done` 统一接受小写连字符格式（与 run done 一致），
内部自动映射到 chain step 状态。Ralph SKILL.md 改为使用统一格式。

```bash
maestro session done {run_id} --verdict done --summary "..." --json
maestro session done {run_id} --verdict needs-retry --summary "..." --json
maestro session done {run_id} --verdict blocked --reason "..." --json
```

---

### O10: 链预验证（session create 时验证所有 step 可解析）

**问题**: 链执行到第 N 步时才发现 `resolveStepContent` 找不到 .md 文件，
导致 Run 创建失败，需要人工干预。

**方案**: `session create --chain-file` 时预验证所有步骤：

```typescript
// chain-admin.ts createChainSession()
for (const step of definition.steps) {
  const content = resolveStepContent(projectRoot, step.command);
  if (!content.prepare && !content.workflow) {
    warnings.push(`step "${step.command}" has no prepare or workflow content`);
  }
}
```

非阻塞（warning），但让编排器在创建时就知道潜在问题。

---

## 三、优化优先级矩阵

| # | 优化项 | 节省/步 | 复杂度 | 依赖 | 优先级 |
|---|---|---|---|---|---|
| **O1** | check→done 合并/跳过重扫 | 1 CLI + 1 scan (~100ms) | 低 | 无 | **P0** |
| **O2** | next --inline-brief | 1 CLI (~300ms) | 中 | O4 | **P0** |
| **O3** | Session 解析快速路径 | ~10ms/次 | 低 | 无 | **P0** |
| **O4** | resolveStepContent 缓存 | ~20ms/次 | 低 | 无 | **P0** |
| **O5** | Continuation 富化 | 编排器决策延迟 | 低 | 无 | **P1** |
| **O6** | Coordinator → Session/Run | 消除双轨 | 高 | Phase 1-3 | **P1** |
| **O7** | Hook TTL 缓存 | ~20ms/刷新 | 低 | 无 | **P1** |
| **O8** | prepare/brief 职责明确 | 认知负担 | 低 | 无 | **P2** |
| **O9** | verdict 格式统一 | 认知负担 | 低 | 无 | **P2** |
| **O10** | 链预验证 | 避免运行时失败 | 低 | 无 | **P2** |

---

## 四、优化后的理想每步流程

### 最快路径（O1+O2+O3+O4 全部生效）

```
编排器:
  maestro session next --session X --inline-brief --json    ← 1 次 CLI
  → { run_id, step, queue, brief: { guidance, contract, continuity } }
  → dispatch executor(session_id, run_id, brief_data)

执行器:
  （已有 brief 数据，直接执行 skill）                         ← 0 次 CLI
  执行完毕

编排器:
  maestro session done {run_id} --verdict done --json       ← 1 次 CLI
  → { continuation: { action: "next", next_step: {...} } }
  → 根据 continuation 循环

每步: 2 次 CLI + 1 次 outputs 扫描 + 1 次 .md 解析（缓存）
```

### 对比

| 指标 | 当前（ralph 路径） | 优化后 | 节省 |
|---|---|---|---|
| CLI 进程/步 | 4（next+brief+check+done） | 2（next+done） | 50% |
| session.json 读取/步 | ~12 | ~4 | 67% |
| outputs 扫描/步 | 2（check+done） | 1（done） | 50% |
| .md 解析/步 | 4 | 1（缓存） | 75% |
| prompt tokens/步 | ~4-6K（双源） | ~2-3K（单源） | 50% |
| 矛盾指令 | 4 处 | 0 | 100% |

---

## 五、适配多编排器的命令面设计

### 统一命令面（Ralph / Coordinator / 人类共用）

```
maestro session create    ← Ralph A_CREATE / Coordinator init / 人类手动
maestro session next      ← Ralph S_LOOP / Coordinator walk / 人类步进
maestro session done      ← Ralph 完成 / Coordinator report / 人类完成
maestro session decide    ← Ralph S_EVALUATE / Coordinator gate / 人类决策
maestro session graph     ← Ralph 全局视图 / Coordinator 进度 / 人类查看
maestro session seal      ← Ralph S_DONE / Coordinator terminal / 人类关闭
maestro session recover   ← Ralph S_RECOVER / Coordinator error / 人类修复

maestro run brief         ← 所有 executor 的唯一正文源
maestro run check         ← 所有 executor 的 gate 检查
maestro run prepare       ← 所有编排器的预读/规划
maestro run create        ← 独立 Run（自动注册进 Session）
```

### Coordinator 特殊需求适配

| Coordinator 概念 | Session/Run 映射 |
|---|---|
| ChainGraph | session.orchestration.chain |
| CommandNode | chain execution step |
| DecisionNode | chain decision step |
| GateNode | contract entry/exit gates |
| WalkerState | SessionState + Run status |
| PromptAssembler | inject.ts builders + run brief |
| cli-executor | run-executor agent |
| coordinate report | session done --verdict |
| ForkNode/JoinNode | 未来: chain parallel steps（当前 sequential） |

### Ralph 特殊需求适配

| Ralph 概念 | Session/Run 映射 |
|---|---|
| ralph-meta.json | session.json orchestration blocks（已迁移） |
| task_decomposition | session.orchestration.decomposition |
| execution_criteria | decomposition.execution_criteria |
| verification_ledger | session evidence registry |
| lease | session.orchestration.lease |
| scope_verdict / phase | session.orchestration.position |
| step_details | chain step enrichment（session/1.1） |

---

## 六、实施路线图

```
Week 1: P0 基础优化
  ├─ O3: Session 解析快速路径（state.json → active_session_id）
  ├─ O4: resolveStepContent 进程级缓存
  ├─ O1: session done 内部跳过重扫（--check-clean 或合并 check）
  └─ O9: verdict 格式统一

Week 2: 命令面重构
  ├─ Session/Run 职责分离（Phase 1 from architecture doc）
  ├─ O2: session next --inline-brief
  └─ O5: Continuation 富化

Week 3: 新增 + 清理
  ├─ session graph 命令
  ├─ O10: 链预验证
  ├─ O8: prepare/brief 职责明确
  └─ 删除 ralph 私有 CLI

Week 4+: Coordinator 统一
  ├─ O6 Phase 1: graph → chain 映射
  ├─ O6 Phase 2: execute 路径走 Session/Run
  ├─ O6 Phase 3: prompt-assembler 复用 inject.ts
  └─ O7: Hook 优化
```
