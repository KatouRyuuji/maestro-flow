---
title: "Maestro 与 maestro-ralph 统一 Session/Run 链架构规划"
status: implemented
date: 2026-07-22
---

# Maestro 与 maestro-ralph 统一 Session/Run 链架构规划

## 0. 结论

Session 不区分 static 或 adaptive，chain 也不携带全局“静态链/动态链”类型。

- `/maestro` 与 `/maestro-ralph` 是两个独立但兼容的编排入口。
- 两者创建、继续和扩展完全相同的 Session，使用相同的 Run、Artifact Registry、chain 和 decision 数据结构。
- 一个 Session 在整个生命周期中不需要 strategy promotion，也不需要从 Maestro Session 转换为 Ralph Session。
- 链是否保持不变或继续生长，由当前调用 Skill 的 contract 和输出决定。
- 普通 Skill 只产出领域 Artifact，chain 不变。
- 具备链编排能力的 Skill 可以产出 typed chain proposal，建议插入、替换、跳过步骤或增加 decision。
- 编排器决定是否接受 proposal；Runtime 负责校验、原子落盘和审计，但不生成业务编排策略。
- Ralph 可以直接在同一个 `session_id` 上扩展 Maestro 已建立的 chain，复用全部 sealed Runs、Artifacts 和 upstream，不 fork、不复制、不升级 Session 类型。

因此，Maestro 与 Ralph 的差异位于默认调用哪些 Skill、如何评价 Skill 输出以及何时停止，而不位于 Session schema 或 chain 类型。

## 1. 统一链模型

### 1.1 Session 只有一种

Session 是 durable topic grouping/index，也是 chain、decision 和 Run lineage 的唯一权威容器：

```text
Session
  ├── intent / boundary / decomposition
  ├── chain[]
  ├── decision_points[]
  ├── Runs[]
  ├── Artifact Registry
  └── transition receipts
```

Session 不记录：

- `strategy=static|adaptive`；
- `session_type=maestro|ralph`；
- `chain_mode=fixed|dynamic`；
- 第二套 Ralph 状态或私有 Session 身份。

`engine` 若因历史兼容继续存在，也不能作为 chain mutation 权限、Session 解析或 `run next` 分配条件。

### 1.2 Chain 只有一种

所有 chain 都是有序、可审计、可在合法边界内修改的 command sequence：

```json
{
  "step_id": "step-003-review",
  "command": "review",
  "args": "--session example",
  "status": "pending",
  "run_id": null,
  "decision_ref": null,
  "inserted_by": "initial-plan"
}
```

链在某次执行中是否发生变化，是运行事实，不是 Session 类型：

- 所有 Skill 都未提出 chain proposal：本次 Session 表现为固定链。
- 某个 Skill 提出并获准应用 chain proposal：同一个 Session 的 chain 继续演化。
- 后续 Skill 不再提出 proposal：chain 再次按当前拓扑顺序执行。

### 1.3 Skill 决定链行为

Skill 通过 contract 声明它可能产生的 chain effects，而不是声明自己属于“静态 Skill”或“动态 Skill”：

```yaml
contract:
  orchestration:
    chain_effects: [insert, replace, skip, decide]
  produces:
    - path: outputs/chain-proposal.json
      kind: chain-proposal
      schema: chain-proposal/1.0
      required: false
```

规则：

- `chain_effects` 缺失或为空：Skill 无权提出 chain mutation。
- 声明 `chain_effects`：Skill 可以按实际结果选择是否产出 proposal。
- 声明能力不意味着每次执行都必须修改 chain。
- Skill 只能提出 contract 允许的 effect。
- Skill 不直接写 `session.json`，也不直接调用 chain mutation CLI。
- executor 只执行 Skill 并返回 Artifact；编排器拥有 proposal 的接受、拒绝或修改权。

这使“动态性”成为 Skill 输出驱动的局部行为，而不是 Session 的全局身份。

## 2. Maestro 与 Ralph 的关系

### 2.1 `/maestro`

`/maestro` 是通用 chain composer/runner：

- 根据 intent 选择或组合初始 chain；
- 创建或继续 Session；
- 通过 `run next/brief/check/complete` 执行 Skill；
- 处理 Skill 产出的普通 Artifact；
- 当 Skill 产出 chain proposal 时，按确认策略决定是否应用；
- chain 耗尽或用户停止时结束。

`/maestro` 调用普通 Skill 时通常表现为预先规划链；调用可产生 chain proposal 的 Skill 时，同样可以扩展当前 chain。

### 2.2 `/maestro-ralph`

`/maestro-ralph` 是闭环控制策略入口：

- 可以创建新的 Session，也可以显式继续任意兼容 Session；
- 默认调用更偏向 evaluation、drift、goal audit、debug 和 repair 的 Skill；
- 对 chain proposal 可采用自动确认、retry budget、confidence 和 escalation 策略；
- 持续运行直到 goal/gate 满足、预算耗尽、阻塞或用户停止。

Ralph 不拥有特殊 Session，也不需要把 Maestro Session 转换为 Ralph Session。它只是同一个 Session/Run 协议上的另一种 orchestrator policy。

### 2.3 兼容矩阵

| 场景 | `/maestro` | `/maestro-ralph` |
|---|---|---|
| 创建 Session | 支持 | 支持 |
| 继续对方创建的 Session | 支持 | 支持 |
| 复用同 Session sealed outputs | 支持 | 支持 |
| 执行普通 Skill | 支持 | 支持 |
| 执行可提出 chain proposal 的 Skill | 支持 | 支持 |
| 自动接受 proposal | 由调用参数/用户确认决定 | 可由 Ralph policy 决定 |
| 修改 completed/sealed/running step | 禁止 | 禁止 |
| 直接写协议 JSON | 禁止 | 禁止 |

兼容是双向的数据和协议兼容；不同入口只改变 orchestration policy，不改变 Session 能力。

## 3. 目标架构

```text
                    ┌──────────────────────────┐
                    │   Shared Session/Run     │
                    │ Session · Run · Artifact │
                    │ Chain · Decision · Lease │
                    └────────────┬─────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
      ┌───────▼────────┐                    ┌───────▼──────────┐
      │    /maestro    │                    │ /maestro-ralph   │
      │ general policy │                    │ closed-loop policy│
      └───────┬────────┘                    └────────┬─────────┘
              │                                      │
              └───────────────┬──────────────────────┘
                              │ dispatch
                     ┌────────▼────────┐
                     │      Skill      │
                     │ Artifact only   │
                     │ or chain proposal│
                     └────────┬────────┘
                              │
                     orchestrator accepts
                              │
                     ┌────────▼────────┐
                     │ Runtime validates│
                     │ + atomic commit │
                     └─────────────────┘
```

依赖方向：

```text
command policy → Skill contract/output → generic Session/Run Runtime → store
```

禁止出现：

- Runtime 内置 drift、goal audit、fix-loop 或业务 chain selection；
- `/maestro` 调用 `/maestro-ralph`，或反向调用；
- Ralph 为扩展 Maestro 工作而 fork/import/copy Session；
- Skill 或 executor 直接修改 Session/Run protocol files；
- `run complete` 隐式调用 `run next`。

## 4. 统一 Run 生命周期

### 4.1 创建或继续 Session

```text
resolve explicit Session or topic
  → if absent: build initial ChainDefinition
  → session create --chain-file
  → retain session_id
```

两个入口都遵守同一解析规则：

- 显式 `--session` 优先；
- 唯一 compatible running topic Session 可以继续；
- historical similarity 只读，不授予 Session mutation 权限；
- 不因创建者是 Maestro 或 Ralph 而拒绝继续。

### 4.2 单步执行

```text
run next --session <id>
  → Run birth packet
  → run brief <run_id>
  → executor executes exactly one Skill
  → run check <run_id>
  → inspect artifacts and optional chain proposal
  → run complete <run_id> --verdict ... [--chain-proposal ...]
  → explicit run next
```

不变量：

- `run next` 是唯一普通 Run allocator。
- executor 不调用 `run complete`，不推进 chain。
- `run complete` 只提交当前 Run、verdict 和获准的 proposal，不创建下一 Run。
- 下一 Run 始终由 orchestrator 显式调用 `run next` 创建。

### 4.3 同 Session 扩展

Ralph 扩展 Maestro Session 不需要 schema 转换：

```text
/maestro created session S
  → completed Runs R1, R2
  → /maestro-ralph --session S
  → run next / run brief
  → Skill emits chain-proposal P1
  → Runtime applies P1 to S
  → later Runs reuse R1/R2 through canonical upstream
```

保持不变：

- `session_id`；
- sealed Runs 和 Run lineage；
- Artifact Registry 和 aliases；
- upstream bindings；
- boundary contract、decomposition 和 transition history。

## 5. Chain Proposal Contract

### 5.1 Artifact schema

建议新增 `chain-proposal/1.0`：

```json
{
  "_meta": {
    "kind": "chain-proposal",
    "schema": "chain-proposal/1.0"
  },
  "proposal_id": "cp-001",
  "source": {
    "session_id": "session-id",
    "run_id": "run-id",
    "skill": "review"
  },
  "reason": "Critical findings require a repair loop",
  "operations": [
    {
      "op": "insert",
      "after": "step-003-review",
      "command": "debug",
      "args": "fix critical findings",
      "goal_ref": "G1"
    }
  ]
}
```

支持的最小 operations：

| operation | 作用 | 约束 |
|---|---|---|
| `insert` | 插入 pending execution/decision step | 必须指定稳定 anchor |
| `replace` | 替换 pending step 的 command/args | 不得替换 running/terminal step |
| `skip` | 跳过 pending step | 必须提供 reason |
| `decide` | 提交或创建 decision point | 必须符合 decision schema |

首版不支持删除历史 step、重排 completed steps 或修改 sealed Run。

### 5.2 Skill contract capability

Runtime 从当前 Run 的 command binding 读取 Skill contract，校验：

- proposal 的 Skill 与 Run binding 一致；
- operation 在 `contract.orchestration.chain_effects` 中；
- proposal 位于当前 Run 的正式 `outputs/` 下；
- `_meta`、schema、proposal ID 和 source locator 完整；
- anchor 和目标 step 仍符合当前 revision；
- operation 不越过 active position，不修改 terminal/running step。

不声明 chain effects 的 Skill 即使写出 proposal，也必须被 `run check` 判为无效，且不得落入 Session。

### 5.3 接受与应用

Skill 产出的是 proposal，不是 mutation authority：

1. executor 完成 Skill，返回 proposal path。
2. orchestrator 依据自身 policy 和用户确认决定 accept、reject 或 revise。
3. accept 时把 proposal 交给 `run complete --chain-proposal <path>`。
4. Runtime 在同一 completion transition 中校验并应用 operations。
5. transition receipt 记录 proposal ID、Skill、Run、operations、reason 和 revision。

建议 machine response 返回：

```json
{
  "proposal": {
    "status": "applied|rejected|not-present",
    "proposal_id": "cp-001",
    "operations_applied": 1
  },
  "next": {
    "suggest_only": true,
    "command": "maestro run next --session session-id"
  }
}
```

### 5.4 原子性与幂等

- Run seal、verdict transition 和 accepted proposal 必须处于同一 durable mutation。
- proposal 失败时 Run 不得表现为“已完成但 chain 未更新”的半状态。
- proposal ID + completion request ID 共同形成 replay key。
- 重放相同 request 返回 applied/replayed，不重复插入步骤。
- revision conflict 时完整拒绝，orchestrator 重新读取 Session 后再评估。

## 6. 当前代码基线与缺口

### 6.1 已具备

- `src/run/next.ts` 已不依赖 Ralph engine，能够推进通用 Session chain。
- `src/ralph/cmd-next.ts` 已是 `runNextStep()` 的兼容适配层。
- `src/ralph/cmd-complete.ts` 已优先调用 `completeRunWithVerdict()`。
- `session chain insert|skip|replace` 已有通用 mutation、revision guard 和 receipt 基础。
- `run complete` 已负责 Run seal、Artifact 注册和 chain verdict 推进。
- Runtime 当前写入 `session/1.3`、`command-run/1.3`。

### 6.2 主要缺口

- 当前 `/maestro` 与 `/maestro-ralph` 在 prompt 内重复实现 chain mutation 决策和 fix-loop 模板。
- chain mutation 来源于 orchestrator prompt 的硬编码，而不是 Skill contract/output。
- 尚无 typed `chain-proposal` artifact 和 capability 校验。
- `run complete` 尚不能原子消费 proposal 并应用 chain mutation。
- `orchestration.engine` 仍被部分 Ralph resolver 用作 Session 类型过滤。
- `maestro ralph skills/session/check/ledger` 仍暴露 Ralph 专属 namespace。
- `/maestro` prompt 仍声明 1.2 schema，与 Runtime 1.3 不一致。

## 7. CLI 收敛

| 当前能力 | 目标能力 | 处置 |
|---|---|---|
| `maestro ralph next` | `maestro run next` | deprecated adapter，仅服务旧调用 |
| `maestro ralph complete/retry` | `maestro run complete --verdict` | deprecated adapter |
| prompt 直接 `session chain insert` | Skill proposal + `run complete --chain-proposal` | 转为 typed/atomic path |
| `maestro ralph skills` | 通用 `maestro skills` 或 `maestro run steps` | 复用现有 scanner/resolver |
| `maestro ralph session` | `maestro session status` | 不按 engine 过滤 |
| `maestro ralph check` | `maestro session check` | 检查通用 chain/Run/decision |
| `maestro ralph ledger` | Artifact/Evidence Registry | 旧 ledger 作为兼容期验证缓存保留；规范查询使用 `maestro session evidence` |
| `resolveRalphSession()` | generic Session resolver | legacy sidecar 仅在 migration adapter 使用 |
| `ralph-executor` | generic single-Run executor | 旧名保留兼容 alias |

`session chain insert|skip|replace` 继续作为 operator/admin 和兼容底层动词，但自动 Skill 驱动路径应优先使用原子 chain proposal。

## 8. 分阶段实施

### P0：锁定统一链契约

- 删除 Session static/adaptive 分类和 promotion 设计。
- 增加双入口继续同一 Session 的 E2E fixtures。
- 固化 `run next` 唯一分配、executor 不 complete、complete suggest-only。
- 修正 `/maestro` prompt 的 1.2/1.3 schema 漂移。

验收：现有 Session/Run lint、contract parity 和 release-machine checks 全绿。

### P1：定义 Skill chain effects

- 扩展 Skill contract schema，增加可选 `orchestration.chain_effects`。
- 定义 `chain-proposal/1.0` schema。
- `run brief` 将允许的 chain effects 注入 birth/resume packet。
- `run check` 校验 proposal 的位置、schema、source 和 capability。

验收：普通 Skill 行为零变化；未声明能力的 proposal 被拒绝。

### P2：Runtime 原子应用 proposal

- `run complete` 增加 `--chain-proposal <path>` machine surface。
- 复用现有 chain-admin mutation，不建立第二套 mutation 实现。
- 将 seal、verdict、proposal operations 合并为单一 durable transition。
- 实现 request/proposal replay、revision conflict 和 rollback 测试。

验收：不存在 Run 已 seal 但 proposal 部分应用的状态。

### P3：收敛 `/maestro`

- 保留初始 chain 分类、组合和通用执行循环。
- 删除 command 内硬编码的“Ralph engine Session 类型”概念。
- 遇到 Skill proposal 时采用交互确认；`-y` 时按明确 policy 自动接受或拒绝。
- 不再自行复制 Skill 应拥有的 fix-loop 业务判断。

验收：`/maestro` 可以在同一 Session 中执行普通 Skill 和 chain-effect Skill。

### P4：收敛 `/maestro-ralph`

- 使用 generic resolver 继续 Maestro 或 Ralph 创建的任意 compatible Session。
- drift、goal audit、review、repair 等逻辑逐步落到对应 Skill contract/output。
- Ralph prompt 只保留 closed-loop policy：proposal 评价、budget、confidence、escalation 和停止条件。
- 所有 Run lifecycle 使用通用 Session/Run CLI。

验收：Ralph 可直接扩展 Maestro Session，无 strategy promotion、engine rewrite 或新 Session。

### P5：中立化辅助能力与兼容层

- 提取 skill scanner/resolver、Session status/check 到通用 namespace。
- verification ledger 收敛到 Artifact/Evidence Registry。
- generic executor 替代 Ralph 专属命名。
- 旧 `ralph next|complete|retry` 保留一个兼容窗口。

### P6：镜像、文档与发布

- canonical-first 修改 command/skill，再通过现有脚本生成 mirrors。
- 更新 Claude、Codex、Agents、Agy、CLI guides 和 architecture guide。
- 增加禁止 Session strategy/static/adaptive 类型重新出现的 lint。
- 运行完整 Session/Run release checks。

## 9. 文件影响范围

| 层 | 主要文件或目录 | 变更重点 |
|---|---|---|
| Command policy | `.claude/commands/maestro.md` | 通用链执行与 proposal 确认策略 |
| Command policy | `.claude/commands/maestro-ralph.md` | 闭环 policy，不拥有私有 Session 类型 |
| Skill contracts | `.claude/commands/`、`.claude/skills/`、workflow registry | chain effects 声明与 proposal output |
| Contract parser | `src/run/contract.ts`、相关 schema | 解析/校验 chain effects |
| Runtime | `src/run/runtime.ts`、`src/run/chain-admin.ts` | completion + proposal 原子 mutation |
| Run CLI | `src/commands/run.ts` | `--chain-proposal` machine surface |
| Session resolver | `src/run/`、`src/ralph/session-adapter.ts` | 删除 engine 类型过滤，保留 legacy migration |
| Ralph adjunct | `src/ralph/cmd-*.ts` | 中立化或 deprecated adapter |
| Executor | `.claude/agents/ralph-executor.md`、Codex agent mirror | generic single-Run executor |
| Policy scripts | `scripts/lint-session-run-*`、mirror scripts | contract、namespace 和镜像一致性 |
| Tests | `src/run/*.test.ts`、`src/ralph/**/*.test.ts`、`src/commands/*.test.ts` | proposal、原子性、兼容和 E2E |

## 10. 测试矩阵

| 场景 | 预期 |
|---|---|
| 普通 Skill，无 proposal | Run 正常 seal，chain 不变 |
| Skill 声明 effect，但本次无 proposal | Run 正常 seal，chain 不变 |
| 未声明 effect 却产出 proposal | check/complete 拒绝，不修改 chain |
| 合法 insert proposal | Run seal 与 step insert 原子成功 |
| proposal 包含未授权 operation | 整体拒绝，不部分应用 |
| proposal 修改 running/sealed step | 拒绝 |
| proposal revision conflict | 拒绝并要求重新读取 |
| completion request replay | 不重复插入 |
| Maestro Session 由 Ralph 继续 | 同一 `session_id`、Run/Artifact lineage |
| Ralph Session 由 Maestro 继续 | generic resolver 可读取并执行 pending step |
| historical similarity | 不自动绑定或接管 Session |
| `run complete` 返回 next | suggest-only，不创建 Run |

至少覆盖以下 E2E：

1. Maestro 创建 chain，执行两个普通 Skill，Ralph 在同 Session 调用 review Skill，proposal 插入 repair loop。
2. Ralph 创建 Session，Maestro 继续剩余普通 steps，不发生 schema 或 engine 转换。
3. 同一 Skill 在一次 Run 无 proposal、下一次 Run 有 proposal，证明行为由本次输出决定。
4. proposal 应用后，新增 Run 能通过 canonical upstream 读取 proposal 来源 Run 的 sealed Artifact。
5. 并发 proposal 使用 revision guard，只允许一个 transition 成功。

## 11. 兼容与迁移

- 不新增 Session strategy、chain mode 或 promotion command。
- 不删除现有 `engine` 字段；兼容读取，但新逻辑不得依赖它判断 Session 能力。
- 不批量重写历史 Session；现有 chain 全部按统一 chain 读取。
- legacy `ralph-meta.json` 仅在 migration adapter 中读取，新 Session 不写。
- deprecated aliases 保持旧参数和 exit code，内部委托通用 Runtime。
- 未升级 contract 的 Skill 默认为 `chain_effects: []`，行为保持不变。
- 迁移 chain mutation 逻辑时先双读旧 prompt verdict 与新 proposal，稳定后停止旧写路径。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Skill 直接获得 Session mutation authority | Skill 只产 proposal；orchestrator 接受，Runtime 校验 |
| proposal 成为新的私有状态源 | proposal 是 Run Artifact；应用后权威状态仍是 session.json/receipts |
| contract 声明过宽 | 最小 chain effects，按 operation 白名单验证 |
| Run seal 与 chain patch 半成功 | 合并为单一 durable mutation，失败整体回滚 |
| 两个编排器同时推进同一 Session | 沿用 lease、active Run 和 revision guards |
| Ralph 覆盖 Maestro decomposition | proposal 默认只能改 chain；goal 变更走单独 meta/supersession contract |
| engine 继续被误用为 Session 类型 | generic resolver 测试和 lint 禁止 engine filter |
| 所有 Skill 都被迫支持 proposal | capability 完全可选，默认无 chain effects |
| prompt 与 Skill 重复做修复决策 | 业务判断逐步下沉到对应 Skill，command 只保留 policy |

## 13. 完成标准

- [x] Session schema 中没有 static/adaptive strategy 或 Maestro/Ralph Session 类型。
- [x] `/maestro` 与 `/maestro-ralph` 能双向继续同一 Session。
- [x] Ralph 扩展 Maestro Session 不需要 promotion、engine rewrite、fork 或 copy。
- [x] chain 是否变化由 Skill contract 和本次 Run 输出决定。
- [x] Skill 只能产出 proposal，不能直接修改 protocol state。
- [x] proposal capability、schema、source、anchor 和 revision 均由 Runtime 校验。
- [x] Run completion 与 accepted proposal 原子提交且支持幂等 replay。
- [x] `run next` 是唯一普通 Run allocator。
- [x] executor 不 complete，`run complete` 不隐式 next。
- [x] Runtime 不包含 drift、goal audit、fix-loop 或业务 routing 策略。
- [x] generic resolver 不按 engine 排除 compatible Session。
- [x] 新 Session 不创建 Ralph 私有 sidecar。
- [x] targeted tests、Session/Run lint、contract parity 和 release-machine checks 全绿。

## 14. 非目标

- 不把 `/maestro` 与 `/maestro-ralph` 合并为一个命令。
- 不为 Session 或 chain 引入 static/adaptive 分类。
- 不允许 Skill 绕过 orchestrator 直接 mutation。
- 不把所有 Skill 强制改造成 chain-effect Skill。
- 不在本迁移中改变 Artifact Registry、knowledge system 或 team skill 的基本边界。

## 15. 实施依赖

```text
P0 统一链契约
  → P1 Skill chain effects + proposal schema
      → P2 Runtime 原子应用
          → P3 /maestro 收敛
          → P4 /maestro-ralph 收敛
              → P5 通用辅助能力与兼容层
                  → P6 发布校验
```

P3 与 P4 可在 P2 后并行，但必须共享同一 proposal contract 和 Session resolver，禁止各自实现 proposal parser、chain patcher 或 Session 选择逻辑。
