---
title: "Maestro 智能协调器指南"
---

通用 chain composer/runner — 分析用户意图、选择 initial chain，并在同一 Session/Run 协议上执行普通 Skill 或 chain-effect Skill。

---

## 定位

Maestro 是 Maestro Flow 的**主入口**：

1. 解析用户意图（action + object + scope）
2. 读取项目状态（`.workflow/state.json`）
3. 从命令链目录中选择 initial chain
4. 创建或继续 Session，通过 `run-executor` 或 direct executor 执行每个 Run

Session/chain 不区分 static/adaptive。普通 Skill 不改链；声明 `orchestration.chain_effects` 的 Skill 可产出 typed proposal，由 Maestro 交互确认或按 `-y` policy 处置，再由 Runtime 原子应用。

与 [Maestro Ralph](./maestro-ralph-guide.md) 的区别：

| | Maestro | Maestro Ralph |
|---|---------|---------------|
| **定位** | 通用 initial chain composer/runner | closed-loop proposal policy |
| **Session/Run 协议** | canonical | canonical，可直接继续 Maestro Session |
| **链变化来源** | Skill proposal | Skill proposal |
| **策略重点** | 交互确认、chain 耗尽停止 | budget、confidence、escalation、goal/gate stop |
| **执行器** | `run-executor` 或 direct | `run-executor` |

---

## 使用方式

```bash
/maestro "实现用户认证功能"     # 意图驱动
/maestro continue               # 基于状态自动推进
/maestro status                 # 查看项目仪表盘
```

### 标志

| Flag | 说明 |
|------|------|
| `-y` | 自动模式：跳过确认，自动传播到下游命令 |
| `-c` | 恢复模式：从上次中断的 session 继续 |
| `--dry-run` | 只展示计划链，不执行 |
| `--exec auto\|cli\|internal` | 强制执行引擎 |
| `--super` | 超级模式：全自动交付 |

---

## 意图路由

Maestro 使用 `action x object` 矩阵进行语义路由：

| action | 触发语义 |
|--------|----------|
| `create` | 构建新功能、组件、spec |
| `fix` | 修复 bug、解决错误 |
| `analyze` | 分析、评估、调查 |
| `plan` | 设计方案、规划、分解 |
| `execute` | 实现、开发、编码 |
| `review` | 代码审查 |
| `test` | 运行/创建测试 |
| `debug` | 诊断、排查 |
| `refactor` | 重构、清理技术债 |
| `explore` | 头脑风暴、发散 |
| `manage` | CRUD/生命周期管理 |
| `continue` | 恢复、继续 |

### 路由示例

| 输入 | 路由 | 命令链 |
|------|------|--------|
| `"Add API endpoint"` | companion | `/maestro-companion "Add API endpoint"` |
| `"plan phase 2"` | plan | step `plan 2` |
| `"debug auth crash"` | debug | step `debug "auth crash"` |
| `"fix issue ISS-abc-001"` | issue-full | analyze → plan → execute → review → close |
| `"brainstorm notifications"` | brainstorm-driven | brainstorm → plan → execute → verify |
| `"continue"` | state_continue | 基于项目状态自动推断 |

---

## 命令链

### 单步链

| 链名 | 步骤（Session chain 内派发） |
|------|------|
| `analyze` | `analyze {phase}` |
| `plan` | `plan {phase}` |
| `execute` | `execute {phase}` |
| `review` | `review {phase}` |
| `test` | `test {phase}` |
| `debug` | `debug "{description}"` |

### 多步链

| 链名 | 步骤 | 场景 |
|------|------|------|
| `full-lifecycle` | plan → execute → review → test → session-seal → harvest | 完整 milestone |
| `roadmap-driven` | init → roadmap → plan → execute | 从需求开始 |
| `brainstorm-driven` | brainstorm → plan → execute | 从探索开始 |
| `execute-review` | execute → review | 规划完成后恢复 |
| `review-fix` | plan --gaps → execute → review | 修复 review 问题 |
| `issue-full` | analyze → plan → execute → review → close | Issue 闭环 |
| `milestone-close` | session-seal | 关闭 milestone |

---

## Session 文件

存储位置：`.workflow/.maestro/maestro-{YYYYMMDD-HHMMSS}/status.json`

<details>
<summary>JSON Schema 示例</summary>

```json
{
  "session_id": "maestro-20260503-143022",
  "source": "maestro",
  "intent": "implement user auth",
  "status": "running",
  "chain_name": "full-lifecycle",
  "task_type": "execute",
  "phase": 1,
  "milestone": "MVP",
  "auto_mode": false,
  "exec_mode": "auto",
  "steps": [
    {
      "index": 0,
      "type": "skill",
      "skill": "plan",
      "args": "1",
      "status": "pending"
    }
  ],
  "current_step": 0
}
```

**Step type**：`"skill"` 当前会话内调用（轻量） / `"cli"` CLI delegate 后台执行（重量）

新 chain 优先使用可执行 Skill step；是否增加 decision 或 repair step 由对应 Skill proposal 决定，而不是由 Maestro/Ralph Session 类型决定。

</details>

---

## 执行流程

```
用户输入 → 意图解析 → initial chain → canonical Session → run-executor/direct → check/proposal/complete
```

1. **意图解析**：提取 action、object、scope、phase_ref
2. **状态读取**：读取 `.workflow/state.json`
3. **链选择**：从 chainMap 选择命令链
4. **类型选择**：预计算 step type（auto：重量 → cli，轻量 → skill）
5. **Session 创建**：通过 `session create --chain-file` 写入 canonical `session.json`
6. **执行派发**：每步通过显式 `run next` 分配，再由所选 executor 执行

### 状态推断（continue 模式）

| 当前状态 | 推断链 |
|----------|--------|
| 未初始化 | `init` |
| 有 roadmap，目标 phase 无 artifact | `analyze` |
| 最新 artifact 是 analyze | `plan` |
| 最新是 plan | `execute` |
| execute 完成（含内置验证），无 review | `review` |
| UAT 通过 | `milestone-close` |
| 所有 phase 完成 | `milestone-close` |

---

## `-y` 自动模式传播

启用 `-y` 后，Maestro 将 auto flag 传播到支持它的下游命令：

| 命令 | Flag | 效果 |
|------|------|------|
| maestro-init | `-y` | 跳过交互提问 |
| analyze | `-y` | 跳过交互 scoping |
| plan | `-y` | 跳过确认和澄清 |
| execute | `-y` | 跳过确认，blocked 自动继续 |
| test | `-y --auto-fix` | 自动触发 gap-fix loop |
| maestro-session-seal | `-y` | 跳过确认（auto 模式） |

---

## 恢复执行

```bash
/maestro -c    # 从最近的 session 恢复
```

恢复模式跳过意图解析和链选择，直接从 status.json 中的下一个 pending step 继续执行。
