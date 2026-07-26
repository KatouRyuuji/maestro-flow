---
title: "Maestro 意图到链规划器指南"
icon: "🤖"
---

意图到链规划器 — 分类用户意图，选择最小充分命令链，创建 canonical Session，进入共享 Run 循环。

> **v0.5.56 架构变更**：Maestro 与 Ralph 合并为**单一 Session 链协议**。"静态 chain 选择器 vs 自适应引擎" 的区分已**消解**——不存在 static/dynamic、Maestro/Ralph 或 executor 专属的 Session 类型。`/maestro` 是**意图到链规划器**（intent-to-chain planner），负责意图分类、初始链选择与 decomposition；`/maestro-ralph` 是**闭环策略层**（Stage Mapping + decision gate）。二者共享同一执行循环（`orchestrator-run-loop.md`），只调用 `maestro session ...` / `maestro run ...`。

---

## 定位

`/maestro` 是 Maestro Flow 的**主入口**与**意图到链规划器**：

1. 解析用户意图与三个公共 flag（`-y` / `-c` / `--amend`）
2. 读取 deferred `workflows/maestro.md` 执行意图分类（intent → task_type → chain）
3. 选择**最小充分初始链**（smallest sufficient initial chain）
4. 通过 `maestro session create --chain-file` 创建 canonical Session
5. 进入共享 Run 循环执行

**One chain, executor-neutral**：每个任务都用同一 Session/Run 协议。链是否动态扩展由每个 Skill contract 决定是否产出 typed `chain-proposal/1.0`，而非 Session 或命令模式。

### Maestro 与 Ralph 的关系

| | `/maestro`（意图到链规划器） | `/maestro-ralph`（闭环策略层） |
|---|---------|---------------|
| **核心职责** | 意图分类 → 初始链选择 → decomposition | Stage Mapping → Build Rules → decision gate 策略 |
| **链构建** | 按意图证据选最小充分链 | 完整生命周期链 + 强制 decision 节点 |
| **decomposition** | 创建 boundary_contract + goals（**owner**） | 消费 goals，goal-audit 判定 met/unmet |
| **适用场景** | 广泛意图路由、单次任务 | 完整 milestone 生命周期推进 |
| **执行** | 共享 Run loop | 共享 Run loop + retry/drift/goal-audit policy |

> 详见 [Ralph 闭环引擎指南](./maestro-ralph-guide.md)。

---

## 使用方式

```bash
/maestro "实现用户认证功能"     # 意图分类 → 建链 → 执行
/maestro -y "添加 OAuth 支持"   # 自动确认低风险分类与 proposal
/maestro -c                     # 继续唯一 live 兼容 Session
/maestro --amend "改为支持 OAuth"  # 修改 live Session 目标
/maestro status                 # 项目仪表盘（route 到 maestro session status）
```

### 公共 Flags

| Flag | 行为 |
|------|------|
| `-y` | 自动确认低风险分类和 proposal；**不越**高风险、低置信度、边界歧义、drift 熔断 |
| `-c` | 继续唯一 live 兼容 Session；多候选必须询问；paused 进入 audited recovery |
| `--amend` | 修改唯一 live Session 的目标；剩余文本为 change request |
| `--executor <agent\|direct>` | 选择执行方式：`agent`（默认）派发 run-executor；`direct` 主 LLM 内联执行。**不改变** Session 类型或链语义 |
| `--dry-run` | 显示 chain 后结束，不执行 |

其余文本**全部视为 intent**。Platform、roadmap、quality、模板复用、并行与对抗策略由 intent、Session state、Skill contract 和 host runtime 推断。

> **已退役 flag**：`--exec auto|cli|internal`、`--super`。执行方式由 `--executor agent|direct` 选择，质量深度由 specs 与可观测风险推断。

---

## 意图分类（A_CLASSIFY）

读取 deferred `workflows/maestro.md`（Chain Catalog），执行意图分类：

1. **Exact match**：`continue/next/go/继续` → `state_continue`；`status/状态` → `status`
2. **Semantic match**：LLM 语义理解匹配 task_type（见下方链目录）
3. **Selection priorities**：`issue_id` > team > UI/design > multi-step > single-step > companion fallback
4. **State validation（W003）**：execute 无 plan → 警告并前置 plan；test 未执行 → 警告并前置 execute
5. **Classification evidence（必须）**：记录匹配了哪个 pattern、排除了哪些备选、confidence level。无记录的分类不可进入建链。

输出：`{ task_type, scope, issue_id, phase_ref, urgency }`

### 意图路由示例

| 输入 | task_type | 命令链 |
|------|------|--------|
| `"修正 README 拼写"` | companion | `/maestro-companion "修正 README 拼写"` |
| `"plan phase 2"` | plan | `plan 2` |
| `"debug auth crash"` | debug | `debug "auth crash"` |
| `"fix issue ISS-abc-001"` | issue_execute | issue-full：analyze --gaps → plan --gaps → execute → review → close |
| `"brainstorm notifications"` | brainstorm-driven | brainstorm → plan → execute → harvest |
| `"分析完直接改"` | analyze-plan-execute | analyze -q → plan --dir → execute --dir |
| `"ui design landing"` | impeccable_build | `maestro-impeccable --chain build` |
| `"continue"` | state_continue | 基于项目状态自动推断 |

---

## 链目录（task_type → chain）

### 单步链

| 链名 | 命令 |
|------|------|
| `analyze` | `analyze {phase}` |
| `plan` | `plan {phase}` |
| `execute` | `execute {phase}` |
| `review` | `review {phase}` |
| `test` | `test {phase}` |
| `test_gen` | `auto-test {phase}` |
| `debug` | `debug "{description}"` |
| `refactor` | `maestro-odyssey --mode improve "{description}"` |
| `retrospective` | `retrospective {phase}` |
| `init` | `maestro-init` |
| `grill` | `grill "{description}"` |
| `blueprint` | `blueprint "{description}"` |
| `analyze-macro` | `analyze "{description}"` |
| `companion` | `/maestro-companion "{description}"` |
| `status` | `maestro session status` |
| `milestone_close` | `maestro-session-seal` |

### 多步链

| 链名 | 步骤 | 场景 |
|------|------|------|
| `full-lifecycle` | plan → execute → review → test → session-seal → harvest | 完整 milestone |
| `spec-driven` | init → roadmap --mode full → plan → execute → harvest | 从需求开始（重） |
| `roadmap-driven` | init → roadmap → plan → execute → harvest | 从需求开始（轻） |
| `blueprint-driven` | init → blueprint → plan → execute → harvest | 从想法/规格开始 |
| `brainstorm-driven` | brainstorm → plan → execute → harvest | 从探索开始 |
| `grill-driven` | grill → brainstorm --from grill → plan → execute → harvest | 压力测试后 |
| `analyze-plan-execute` | analyze -q → plan --dir → execute --dir → harvest | 快速通道（adhoc） |
| `quality-loop` | review → auto-test → test → debug → plan --gaps → execute | 质量修复 |
| `review-fix` | plan --gaps → execute → review | 修复 review 问题 |
| `issue-full` | analyze --gaps → plan --gaps → execute → review → close → harvest | Issue 闭环 |
| `next-milestone` | roadmap → plan → execute | 下一里程碑 |
| `milestone-close` | session-seal | 关闭 milestone |

> 完整链目录与 chainMap 见 `workflows/maestro.md`。裸命令名（`plan`、`execute`…）是 first-tier Skill 步骤；`maestro-*` 与 `maestro-odyssey --mode improve` 是独立 command 名。

### Minimum Chain Rules

| 意图证据 | 初始链 |
|---------|--------|
| 窄修复/变更 | analyze → plan → execute → review/test（按需） |
| 广泛重写/迁移 | analyze-macro → scope decision → plan/roadmap |
| 头脑风暴/探索 | brainstorm → 仅 Skill-proposed continuation |
| 压力测试/grill | grill → 仅 Skill-proposed continuation |
| 正式规格 | blueprint → plan |
| 已有 compatible Session | 不重建；进入共享循环 |

Roadmap 仅在多 release 证据时推断。Quality 基于 specs 和可观测风险，非用户 flag。

---

## resolvePhase 优先级

1. `intent_analysis.phase_ref`（结构化提取）
2. 正则匹配 "phase N" 或裸数字
3. 项目状态推断：in-progress execute → 首个未完成 phase → 最新 artifact phase
4. `analyze-plan-execute` 链 → null（用 `{run_dir}`）
5. 所有命令均 phase-independent → null
6. 询问用户

---

## 分解协议（A_DECOMPOSE）

设 `decomposition_owner = "maestro"`。下游 ralph 只消费不二次提问。

1. 分类意图广度：narrow / 单步 / {status, init} 链 → 跳过分解
2. broad/medium → 最多问 3 轮：Scope / Constraints / Definition of Done（`-y` 不跳过广泛歧义）
3. 派生 `execution_criteria` + `goals`（每个含 `done_when` + `evidence` + `lifecycle`）
4. `boundary_contract` 随 `session create` 建入；goals 装入 chain-file 的 `decomposition` 块

```json
{
  "boundary_contract": { "in_scope": [], "out_of_scope": [], "constraints": [], "definition_of_done": "" },
  "decomposition": {
    "execution_criteria": [],
    "goals": [{ "id": "G1", "goal": "", "done_when": "", "evidence": "", "lifecycle": [], "status": "pending" }]
  }
}
```

> Goals 描述**结果**而非生命周期阶段。分解完成后输出 `/goal` 绑定提示词（不阻塞）。

---

## 建链协议（A_CREATE）

1. **Specs 预检**：chain 含执行 stage 且 `.workflow/specs/` 不存在 → 在 steps 最前面插入 `specs-setup`
2. **Skill 名预校验**：所有 step 的 skill 名通过 `maestro skills --steps --json` 预校验；未命中 → 报错 E005，阻断建链
3. **组装 chain-file**（execution step 仅 `command/args?/stage?/goal_ref?/retry_max?`；decision step 声明 `decision_ref`）
4. **创建**：

```bash
maestro session create "{intent}" --id maestro-{slug} --chain-file {path}
```

删除临时文件后进入共享执行循环（`orchestrator-run-loop.md`）。

---

## Session 文件（session.json）

存储位置：`.workflow/sessions/{session-id}/session.json`（schema `session/1.3`）。`session.json.orchestration` 是 chain / goal / decision 的唯一真相源。

```json
{
  "schema": "session/1.3",
  "session_id": "maestro-fix-login",
  "intent": "implement user auth",
  "status": "running",
  "orchestration": {
    "engine": "coordinator",
    "quality_mode": "standard",
    "auto_mode": false,
    "chain": [
      { "command": "analyze", "args": "--session {session}", "stage": "analyze", "goal_ref": "G1", "status": "pending" }
    ],
    "decomposition": { "goals": [{ "id": "G1", "goal": "...", "done_when": "...", "status": "pending" }] }
  },
  "boundary_contract": { "in_scope": [], "out_of_scope": [], "constraints": [], "definition_of_done": "" }
}
```

- `engine: coordinator` 是兼容持久化字段，不是 Session 类型或策略
- `{session}` `{intent}` 占位符由运行时替换
- 链推进由 **verdict 驱动**：执行步 `session done --verdict`，决策步 `session decide --verdict`

> **legacy 迁移**：旧的 `.workflow/.maestro/maestro-*/status.json` 通过 `maestro session migrate` 折叠进 `sessions/{id}/session.json`（幂等）。

---

## 执行流程

```
用户输入 → 意图分类 → chain 选择 → session create --chain-file → 共享 Run 循环
```

共享 Run 循环（与 Ralph 一致）：

```
session next --inline-brief --json   ← 分配下一 Run（birth packet 内联 Resume Packet）
        ↓
派发一个 unnamed run-executor（只执行该 Run）
        ↓
maestro run check {run_id}           ← 扫描输出、评估 gate、校验 chain-proposal/1.0
        ↓
maestro session done {run_id} --verdict ...   ← verdict 驱动链推进
        ↓
读取 continuation：dispatch_next / evaluate_decision / seal_session
```

详见 [Ralph 指南的执行循环章节](./maestro-ralph-guide.md)。

### 状态推断（continue / state_continue 模式）

| 当前状态 | 推断链 |
|----------|--------|
| 未初始化 | `init` |
| 有 roadmap，目标 phase 无 artifact | `analyze` |
| 最新 artifact 是 analyze | `plan` |
| 最新是 plan | `execute` |
| execute 完成，无 review | `review` |
| UAT 通过 | `milestone-close` |
| 所有 phase 完成 | `milestone-close` |

---

## `-y` 自动模式

`-y` 只扩大低风险裁量，正常生命周期续跑不依赖 `-y`：

- **可自动**：pending-tail 内已验证且 intent-aligned 的 proposal；低风险分类决策
- **必须停**：高风险、低置信度、边界歧义、失败 gate、drift 熔断、paused recovery

`-c` 继承 `session.orchestration.auto_mode`，不要求用户重复输入 `-y`。

---

## 恢复执行（-c）

```bash
/maestro -c    # 继续唯一 live 兼容 Session
```

1. 用只读 `maestro run recall` + `session status` 定位唯一 live Session
2. 多个 live 候选要求显式选择；historical similarity 只读，不授予 authority
3. paused Session 走共享 `session recover`（audited recovery）
4. sealed/archived Session 是终态，不可 resume

---

## Invariants（Maestro 特有）

1. **One chain, executor-neutral** — `agent|direct` 只选择 executor，不产生 Session 分型
2. **Session before execution** — session.json 经 `session create --chain-file` 创建后才执行
3. **Creator owns decomposition** — Maestro 创建 boundary_contract + goals；后续 orchestrator 只消费不覆盖
4. **Classification evidence** — 分类必须留痕（匹配 pattern、排除备选、confidence）
5. **Verdict 驱动链推进** — 由 `session done --verdict` 驱动 chain step 完成
6. **Runtime owns mutation** — prompt 不写 session.json/run.json，不自动使用 admin chain 命令
7. **控制权优先级** — Maestro 拥有 initial chain 选择 + proposal disposition；Skill 拥有领域判断；Runtime 独占 mutation authority

---

## 相关指南

- [Ralph 闭环引擎与协调器](./maestro-ralph-guide.md) — 闭环策略层
- [全部命令与工作流](./command-usage-guide.md) — slash 命令与链目录
- [CLI 终端命令参考](./cli-commands-guide.md) — `maestro session` / `maestro run`
- [产物目录结构](./workflow-structure-guide.md) — session.json Schema
