---
title: "质量管线指南"
icon: "✅"
---

Maestro 质量管线完整参考：围绕 **"审查 → 测试 → 调试 → 重构 → 复盘"** 闭环组织。v0.5.56 起，质量门由 Ralph 策略作为 **decision 节点**（`post-execute` / `post-business-test` / `post-review` / `post-test` / `post-frontend-verify`）插入 canonical Session/Run 链，由只读 evaluator 评估并通过 `maestro session decide --verdict` 提交裁决。

---

## 命令总览

| 命令 | 定位 | 核心问题 | 产物 ID |
|------|------|---------|---------|
| `review`（Skill 链步） | 分层代码审查 | 代码质量是否达标？ | `REV-{NNN}` |
| `test`（Skill 链步） | 会话式 UAT | 用户视角是否正常？ | `TST-{NNN}` |
| `auto-test`（Skill 链步） | 统一自动测试 | 覆盖率和回归是否通过？ | `TST-{NNN}` |
| `/maestro-odyssey --mode debug` | 假设驱动调试 | 根因是什么？ | `DBG-{NNN}` |
| `maestro-odyssey --mode improve` | 反思驱动重构 | 技术债是否收敛？ | `WBR-{NNN}` |
| `maestro kg index` | 文档同步 | 文档与代码是否一致？ | — |
| `retrospective`（`/maestro "复盘 phase N"`） | 阶段复盘 | 可复用的洞察是什么？ | `INS-{8hex}` |

> 裸命令名（`review`、`test`、`auto-test`）是 Skill 链步骤，由 `/maestro` 路由或 `maestro session start --chain ...` 在 canonical Session 内执行；质量门（`post-*`）是 Ralph 策略插入的 decision 节点。

---

## review — 分层代码审查（◆post-review）

```bash
/maestro "review phase N"              # 经 /maestro 路由 review 链步
review --session {session} [--tier quick]   # 链内 Skill 命令（quick 模式追加 --tier quick）
```

| 参数 | 说明 |
|------|------|
| `{phase}` / `--session {session}` | Phase 编号或 Session 绑定 |
| `--tier quick` | 快速审查层级（quality_mode=quick 时自动追加） |

**审查层级**：Quick（小改动内联审查）→ Standard（并行 Agent 按维度审查，自动 deep-dive）→ Deep（多轮聚合），由 quality_mode 与可观测风险推断。

产物路径：`runs/{run-id}/outputs/review.json`（或 `scratch/{YYYYMMDD}-review-P{N}-{slug}/review.json`）

审查后由 **`post-review` decision gate** 评估（只读 evaluator 读取 review.json）：

| Verdict | 含义 | 下一步 |
|---------|------|--------|
| `proceed`（PASS/WARN） | 通过或非关键问题 | `session decide --verdict proceed` → 继续测试 |
| `fix`（BLOCK） | 关键问题，必须修复 | repair Skill 产生 `chain-proposal/1.0` → `plan --gaps → execute` |
| `escalate` | 越限升级 | 转 audited recovery |

---

## test — 会话式 UAT（◆post-test）

```bash
/maestro "test phase N" [--smoke] [--auto-fix]
test --session {session} [--frontend-verify]   # 链内 Skill 命令
```

| 参数 | 说明 |
|------|------|
| `--smoke` | UAT 前注入冒烟测试 |
| `--auto-fix` | 自动 gap-fix 循环（plan--gaps→execute→re-verify，最多 2 轮） |
| `--frontend-verify` | 交付 UI 时插入 frontend-verify 门（e2e） |

**流程**：从 `verification.json` 提取场景 → 逐场景交互 → 自动推断严重性（blocker/major/minor/cosmetic）→ 问题按 gap cluster 并行 debug

产物路径：`runs/{run-id}/outputs/`（uat.md, test-plan.json, test-results.json）

| 条件 | 下一步 |
|------|--------|
| 全部通过 | `post-test` decision gate proceed → `/maestro-session-seal` |
| `--auto-fix` 成功 | 已通过 decision gate 验证 |
| 仍有问题 | `/maestro-odyssey --mode debug "<from-uat {phase}>"` |
| 覆盖率不足 | `auto-test {phase}`（test-gen） |

---

## auto-test — 统一自动测试（◆post-business-test）

```bash
/maestro "auto-test phase N"
auto-test --session {session}   # 链内 Skill 命令（business-test / test-gen）
```

**智能路由**：

| 优先级 | 条件 | 路由 |
|--------|------|------|
| 1 | 存在活跃会话 | 恢复会话 |
| 2 | 重跑 + 之前有失败 | 重跑失败 |
| 3 | 存在 REQ-*.md | spec 路由 |
| 4 | 存在覆盖缺口 | gap 路由 |
| 5 | 默认 | code 路由 |

**层级波浪**：L0→L1→L2→L3 顺序执行，CSV 并行写入 + CSV 并行诊断

产物路径：`runs/{run-id}/outputs/`（test-plan.json, scenarios.csv, report.json）

| 条件 | 下一步 |
|------|--------|
| 收敛（≥95%） | `post-business-test` decision gate proceed |
| 发现 Bug | `/maestro-odyssey --mode debug "<from-uat {phase}>"` |
| 最大迭代，>80% | `test {phase}`（UAT） |
| 最大迭代，<80% | `/maestro-odyssey --mode debug "{phase}"` |

---

## maestro-odyssey --mode debug — 假设驱动调试

```bash
/maestro-odyssey --mode debug "<issue description>" [--from-uat <phase>] [--parallel]
```

| 模式 | 触发方式 | 症状来源 |
|------|---------|---------|
| 独立 | 直接提供问题描述 | 交互收集 |
| UAT 衔接 | `--from-uat` | 从 `uat.md` 加载 |
| 并行 | `--parallel` | 每 gap cluster 独立 Agent |

**调试循环**：症状收集 → 假设生成 → 隔离验证 → 根因确认 → 就绪门控 → 压力测试

产物路径：`scratch/{YYYYMMDD}-debug-P{N}-{slug}/`（understanding.md, evidence.ndjson）

| 条件 | 下一步 |
|------|--------|
| 根因已找到 | `/maestro "plan {phase} --gaps"`（review-fix 链） |
| UAT 衔接 + 自动修复 | `/maestro "test {phase}" --auto-fix` |
| 结论不明确 | 恢复调试会话（`-c`） |

---

## maestro-odyssey --mode improve — 反思驱动重构

```bash
/maestro-odyssey --mode improve [<scope>]    # scope: 模块路径 | 功能区域 | all
```

每轮：**分析**（识别影响）→ **规划**（确认后执行）→ **反思**（测试验证 + 策略调整）

产物路径：`scratch/{YYYYMMDD}-refactor-{scope}/reflection-log.md`

---

## maestro kg index — 文档同步

```bash
maestro kg index [--full] [--since <commit|HEAD~N>] [--dry-run]
```

通过 `git diff` 检测变更 → `doc-index.json` 追踪影响链 → 更新 `.workflow/codebase/` 文档。

---

## retrospective — 阶段复盘

```bash
/maestro "复盘 phase N"        # retrospective 链：4 个并行 Lens（Technical / Process / Quality / Decision）
/maestro-knowhow "洞察"   # 知识沉淀（knowhow）
```

> v0.5.56 起，阶段复盘由 `retrospective` Skill 承担（经 `/maestro "复盘 phase N"` 路由）；知识 promotion/捕获走 `/maestro-knowhow` 或 `harvest`。旧的 `maestro-next --promote` 已退役（`/maestro-next` 现为纯路由器）。

4 个并行 Lens（Technical / Process / Quality / Decision），洞察自动路由：

| 路由目标 | 条件 |
|---------|------|
| Spec stub | 可复用模式/约束 |
| Issue | 反复出现的 gap |
| Knowhow tip | 流程笔记/提醒 |
| Learnings | 所有洞察（始终） |

---

## 质量闭环流转

```
              ┌──────────────────────────────────────────────┐
              │           Phase 执行完成（execute）            │
              └───────────────────┬──────────────────────────┘
                                  │
              ┌───────────────────▼──────────────────────────┐
        ┌─────┤   review → ◆post-review 决策门（审查）         │
        │     └───────────────────┬──────────────────────────┘
        │ fix                     │ proceed
        ▼                         ▼
┌───────────────────┐   ┌──────────────────────────────────────┐
│ plan --gaps        │   │  test / auto-test → ◆post-test（测试） │
│ → execute（修复）   │   └───────────────────┬──────────────────┘
└────────┬──────────┘                       │
         │                                │ 发现问题
         │ 执行修复                        ▼
         ▼                       ┌────────────────────────────┐
┌───────────────────┐            │ maestro-odyssey --mode debug │
│ execute → 重跑 gate │◄──────────┤ （调试）                      │
└────────┬──────────┘            └─────────────┬──────────────┘
         │                                     │
         │ 根因找到                             │
         ▼                                     │
┌───────────────────┐                          │
│ 重跑测试循环       │◄─────────────────────────┘
└────────┬──────────┘
         │ 全部通过
         ▼
┌──────────────────────────────────────────────────┐
│  maestro-odyssey --mode improve（可选，处理技术债）              │
│  maestro kg index（同步文档）          │
│  /maestro "复盘 phase N"（复盘，知识回流）          │
└──────────────────────────────────────────────────┘
```

> 质量门是 Ralph 策略插入的 **decision 节点**，由只读 evaluator 评估并通过 `maestro session decide --verdict proceed|fix|escalate` 提交裁决。`fix` verdict 由 repair Skill 产生 `chain-proposal/1.0` 插入修复 step。

<details>
<summary>决策树：何时用哪个命令</summary>

```
代码刚执行完
  ├─ 需要代码质量评估？──> review "<phase>"（◆post-review 决策门）
  │    ├─ proceed ──> 继续测试
  │    └─ fix ──> /maestro "plan <phase> --gaps"（review-fix 链）
  │
  ├─ 需要用户验收？──> /maestro "test <phase>"
  │    ├─ 全通过 ──> /maestro-session-seal
  │    └─ 有问题 ──> /maestro-odyssey --mode debug "<from-uat <phase>>"
  │
  ├─ 需要自动化测试？──> auto-test "<phase>"（◆post-business-test）
  │    ├─ 收敛 ──> 已通过 decision gate
  │    └─ 发现 Bug ──> /maestro-odyssey --mode debug "<from-uat <phase>>"
  │
  ├─ 有已知 Bug？──> /maestro-odyssey --mode debug "<issue>"
  │    ├─ 根因明确 ──> /maestro "plan <phase> --gaps"
  │    └─ 不确定 ──> 继续调试
  │
  ├─ 需要减少技术债？──> /maestro-odyssey --mode improve <scope>
  │    ├─ 测试通过 ──> maestro kg index
  │    └─ 测试失败 ──> /maestro-odyssey --mode debug "<scope>"
  │
  ├─ 代码改了文档没更新？──> maestro kg index
  │
  └─ Phase 完成需要复盘？──> /maestro "复盘 phase N"（retrospective）
       ├─ 有洞察 ──> 自动路由到 spec/issue/knowhow
       └─ 完成后 ──> maestro session status
```

</details>

---

## 与 Phase 管线集成

`/maestro-ralph` 闭环链将质量门作为 decision 节点插入，是质量命令的标准入口：

```bash
/maestro-ralph "实现 X"    # execute → ◆post-execute → review → ◆post-review → test → ◆post-test → seal
/maestro "全面质量检查"     # quality-loop 链：review → auto-test → test → debug → plan --gaps → execute
```

`--gaps` 是质量管线与 Phase 管线的核心桥梁：

| 触发场景 | 命令 |
|---------|------|
| `post-review` 决策门裁定 fix | `/maestro "plan {phase} --gaps"`（review-fix 链） |
| `maestro-odyssey --mode debug` 确认根因 | `/maestro "plan {phase} --gaps"` |
| `test --auto-fix` | 自动调用 `plan --gaps → execute → decision gate` |

**里程碑审计前检查点**：所有 Phase 已通过 decision gate → 关键 Phase 已 review → 核心功能已 test → 问题已闭环 → 复盘已完成

---

## 相关指南

- [Ralph 闭环引擎与协调器](./maestro-ralph-guide.md) — decision gate 分类与评估
- [全部命令与工作流](./command-usage-guide.md) — 链目录
- [CLI 终端命令参考](./cli-commands-guide.md) — `maestro session decide`
