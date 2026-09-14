---
title: Maestro 始终在线指令预算
purpose: 把每轮必读的 Maestro 指令压到「任务 + 护栏 + 完成标准 + 路由」，条件性流程进 Skill，硬保证进 Hook。
audience: 人读；不参与运行时加载
scope: maestrogrok/repo 通用能力（安装器写入各宿主的 Maestro 段）
out_of_scope: 用户四端同步的「工作原则」正文（走 agent-prompts-sync）
---

# Maestro 始终在线指令预算

本文回答一件事：Maestro 安装进各宿主「每轮必读」文件的手册，按什么标准拆、拆完长什么样、按什么顺序落地。

判定句：对每一行问「删掉会不会让模型立刻犯错？」不会就删。规则被忽略时，先删与它竞争注意力的规则，而不是加粗再写一遍。

---

## 1. 问题描述

### 1.1 现象

Maestro 安装器把同一套手册 tag-inject 进宿主每轮必读文件。源文件与本机落点如下。

| 源文件 | 行数 | 安装落点 |
| --- | ---: | --- |
| `workflows/claude-instructions.md` | 258 | `~/.claude/CLAUDE.md`（`inject: true`） |
| `workflows/grok-instructions.md` | 274 | `~/.grok/rules/maestro.md` |
| `workflows/codex-instructions.md` | 275 | Codex / Cursor / 多数 EXTRA_PLATFORMS 的 `AGENTS.md` |
| `workflows/agy-instructions.md` | 251 | Agy `GEMINI.md` / `AGENTS.md` |
| `workflows/chinese-response.md` | 26 | 同上，`section="chinese"` |

本机实测（安装后）：

| 文件 | 行数 | 每轮是否进入模型 |
| --- | ---: | --- |
| `~/.claude/CLAUDE.md` | 308 | 是（用户原则 + Maestro 段） |
| `~/.cursor/AGENTS.md` | 323 | 是 |
| `~/.grok/AGENTS.md` | 32 | 是（仅用户原则） |
| `~/.grok/rules/maestro.md` | 300 | 是。Grok 把 `$GROK_HOME/rules/` 下每个 `*.md` 当作 user rules 全量加载 |
| `~/.maestro/workflows/delegate-usage.md` | 104 | Claude 侧 `@` 引用会在启动时展开进上下文 |
| `~/.maestro/workflows/coding-philosophy.md` | 71 | 与始终在线 Core Beliefs 正文重复 |

Claude 官方文档对 `CLAUDE.md` 的软目标是单文件不超过约 200 行；更长会多占上下文、降低遵守率。Maestro 段单独已超过这个软目标，再叠用户原则与 `@` 展开文件。

### 1.2 误判

`~/.grok/AGENTS.md` 变瘦，不等于 Grok 侧 Maestro 指令变少。安装器把 Maestro 从 `AGENTS.md` 挪到 `rules/maestro.md`，目的是避免与用户正文叠两套 Maestro。Grok 官方发现路径是：`~/.grok/rules/` 下每个 `*.md` 每轮都进 user rules，没有按任务、按路径开关。注意力税与 Claude / Cursor 同量级。

### 1.3 问题边界

- **在范围内：** `workflows/*-instructions.md`、`chinese-response.md`、安装器 inject 目标、始终在线与 Skill / Hook 的分工、`instruction-authoring-guide.md` 里「不信任 hook、改写进提示词」的作者规范。
- **不在范围内：** 用户四端同步的「工作原则」（中文回复、Git 署名、文档写法）。那是 `user-prompts-update` / `~/agent-prompts-sync`。Maestro `--force` 只覆盖 `<!-- maestro:start -->` 段。
- **不在范围内：** 把编排协议再抄进主文件。`maestro` / `maestro-next` / `maestro-ralph` / `maestro-knowledge` 等 Skill 已经承载完整协议。

### 1.4 失败模式

始终在线文件同时承担四件事：编码哲学口号、Explore 操作教程、Knowledge 治理百科、宿主工具陷阱。后三类里只有「宿主工具陷阱」是每轮都成立、代码里读不出来的硬坑。其余在简单改文件、读代码、改文案时是噪音，并与 Skill 正文重复。

`maestro-knowledge` Skill 标了 `disable-model-invocation: true`。模型不会按描述自行打开它，治理条文因此被塞进每轮上下文。

Claude 的 `@~/.maestro/workflows/delegate-usage.md` 在启动时展开。Grok 对应写法是「要用再 `cat`」，注意力更省。

---

## 2. 深入分析

### 2.1 注入链

```text
workflows/claude-instructions.md  ──inject──▶  ~/.claude/CLAUDE.md
workflows/grok-instructions.md    ──inject──▶  ~/.grok/rules/maestro.md
workflows/codex-instructions.md   ──inject──▶  ~/.cursor/AGENTS.md 等
workflows/chinese-response.md     ──inject──▶  同上，section="chinese"
```

实现：`src/core/component-defs.ts` 的 `inject: true`；`src/core/tag-injector.ts` 的 `<!-- maestro:start/end -->`。Grok 额外走 `EXTRA_PLATFORMS`：`contextFile: 'rules/maestro.md'`，`contextSource: 'grok-instructions.md'`。

四份 `*-instructions.md` 主体同构，按宿主补一小段工具 API（Claude `Agent()`、Grok `spawn_subagent`）。手册级内容复制四次。

### 2.2 始终在线段 triage

对 `claude-instructions.md` / `grok-instructions.md` 按「删掉是否立刻犯错」分类。

| 段 | 约行数 | 判定 | 理由 |
| --- | ---: | --- | --- |
| Coding Philosophy、Context Requirements、「先找 3 个同类」 | ~75 | 移出始终在线 | 口号与仪式；与 Minimize changes 重复；代码与 linter 已覆盖的不写进每轮 |
| Explore 教程（FIND+SCOPE 表、正反例） | ~80 | 进 Skill 或 `maestro explore --help` | 条件性流程，只有探索任务才用 |
| Knowledge 百科（stage / review / promote、TOCTOU、session/2.0 资格） | ~80 | 进 `maestro-knowledge`，并允许模型按需调用 | 日常改代码用不到；Skill 已有约 60 行 |
| Delegate 全文 | Claude `@` 展开 104 行 | 一行索引 + 按需 `cat` | Grok 已是这种写法 |
| 中文回复 | 26 | 保留为选装 inject | 密度已经够；选中 chinese 组件才写入 |
| 宿主工具陷阱（Grok 禁用 Codex agent API、join 子代理、Goal 工具勿乱用） | ~20–30 | 留在始终在线 | 代码里读不出来，用错立刻失败 |
| Knowledge Gate「先 `maestro search`」 | 现为长手册 | 留约 5 行命令；细节进 Skill；硬保证进 Hook | 中强模型需要明确指令，不需要百科 |
| Minimize changes / 禁止主动写文档 | 已有 | 留 2 条 | 模型会反复踩 |

目标不是把指令清空，而是 **约 40–60 行内核 + 路由表**。中文选装另计约 26 行。

### 2.3 与现有 Skill / Hook 的重叠

始终在线并不是「唯一真源」。加载关系已经是三层，主文件再贴手册是重复纳税。

| 能力 | 已有承载 | 始终在线重复程度 |
| --- | --- | --- |
| Session / Run 编排 | `maestro`、`maestro-next`、`maestro-ralph` Skill | 主文件几乎不写编排状态机，这一块相对干净 |
| Knowledge 治理 | `maestro-knowledge` Skill（约 60 行，禁止模型自发调用） | 主文件重写 stage/review/promote |
| 知识检索 | `spec-injector`、`keyword-spec-injector` Hook | 主文件写完整 Query Rules 与治理边界 |
| Delegate | `~/.maestro/workflows/delegate-usage.md` | Claude `@` 每轮展开 |
| 编码哲学 | `coding-philosophy.md` | 主文件内联同一套 Core Beliefs |

### 2.4 作者规范与运行时诊断对齐

`workflows/instruction-authoring-guide.md` 的核心原则已经是「只写会改变模型行为的句子」。同一份指南把依赖 hook 写成反模式：

> `"hooks handle it"` / `"auto-loaded"` → `"ALWAYS search before acting."`

结果是：硬约束继续堆进每轮散文，Hook 保持 fail-open。

`guide/maestro-workflow-diagnosis.md` 的根因是同一句话的工程版：保证被写成只有 LLM 才执行的自然语言不变量。R8：`spec-injector` 空库时无告警，`ALWAYS search before acting` 是装饰。

优化主文件而不把「必须成立」的保证搬进 Hook / 代码，注意力税下降，遵守率不一定上升。

### 2.5 模型能力与脚手架

本机 Claude 侧走 Kimi K3，不是 Anthropic Opus 5。可迁移原则：

> 模型越强，始终在线的规则越少。弱/中模型需要更明确的指令，但指令预算更紧，所以更要挑高信号。

Kimi K3 需要 join 子代理、先 search、少改动这类硬轨，不需要 SOLID 口号，也不适合 Opus 5 那种「几乎清空系统提示词」。密度对齐 Karpathy 四条，而不是对齐 Opus 5 ablation 的删除比例。

### 2.6 用户原则与 Maestro 段的关系

用户「工作原则」里仍然值钱、且社区没有替代品的，不属于本文改造对象：中文回复与 Git 约定、文档只写当前实现/设计/目的、以仓库当前代码为准、复用已有实现、审阅任务的质量标准。

用户原则里与 Maestro 段互相打架的条款（「不明确就问到明确」vs 可逆的事先做；「必须重视文档」vs 禁止主动写文档；持续重构 vs Minimize changes）由用户原则自己 ablation，不在 Maestro 安装器里调和。主文件内部的矛盾优先删 Maestro 段里的口号，把「少改、不主动写文档」留成硬轨。

---

## 3. 行业调研

跨官方文档、论文、高质量实践重复出现的共识如下。人设向超长提示词（角色扮演、修仙）是流量帖，不作为依据。

### 3.1 官方：CLAUDE.md 是建议，短、可证伪、按需加载

Anthropic Claude Code 文档（How Claude remembers your project）：

- `CLAUDE.md` 是上下文，不是强制配置；写法影响遵守率。
- 单文件软目标约 200 行。更长会多占上下文、降低遵守率。
- 条件性内容用 path-scoped rules，只在匹配路径时加载。
- `@` import 仍在启动时进入上下文，拆文件不等于省 token。
- 200 行 / 25KB 硬上限属于 auto-memory 的 `MEMORY.md`，不是 `CLAUDE.md`。`CLAUDE.md` 最长约 4 MiB 仍会整文件加载；遵守率问题来自注意力，不是截断。

对每一行问「删掉会不会让模型犯错」是社区把官方软目标操作化后的同一条过滤器。

### 3.2 指令预算：系统提示词已经占掉名额

HumanLayer 对 Claude Code harness 的统计：系统提示词本身约 50 条指令。前沿模型较稳定跟随的指令数大约 150–200 条；数量增加时，遵守率是整体下降，不是只丢掉文件后半。HumanLayer 自己的根 `CLAUDE.md` 少于 60 行。

IFScale（Jaroslawicz et al., 2025）给出同一量级：指令跟随在约 150–200 条总指令附近开始明显变差。

含义：Maestro 再往始终在线里塞 Explore 教程和治理百科，是在和宿主系统提示词抢同一预算。

### 3.3 论文：自动生成的超全 AGENTS.md 有负收益

ETH Zürich SRI Lab 与 LogicStar 的工作（arXiv:2602.11988，2026-02）：在 SWE-bench 与基于真实 GitHub issue 的基准上测四种编码 agent。

- 上下文文件被 agent 遵守，遵守不等于任务成功率上升。
- LLM 生成的上下文文件在多数设置里拉低成功率。
- 推理成本平均上升 20% 以上。
- 人手写的、只写代码里读不出来的非标准约定，才有正收益（约几个百分点，且统计显著性弱）。
- 仓库结构综述几乎无用：agent 本来就会读代码。

结论句与本文判定句同构：只写代码库里没有的、具体的额外指令。

### 3.4 行为约束，不要人格扮演

GitHub 上高星传播的是 Forrest Chang 把 Karpathy 观察写成的约 70 行、4 条 `CLAUDE.md`（`andrej-karpathy-skills`），不是 Linus 人设：

1. 动手前先想：不静默假设。
2. 最简方案：不为一次性逻辑做抽象。
3. 外科手术式修改：只动必须动的。
4. 目标驱动：先定义可验证的完成标准，循环直到验证通过。

linux.do「求一个规范 AI 写代码的提示词」置顶回复，结构就是这四条的中文版。高质量实践帖走「主文件约 60 行内核 + 索引，细节放 docs/skills」；把 CLAUDE.md 当微型 OS 内核、按任务动态加载，而不是把操作系统写进 BIOS。

### 3.5 结果导向，不要步骤微管理；ablation 不是 accretion

Claude Code 作者 Boris Cherny 2026-07 在 YC Startup School：为 Opus 5 删掉约 80% 系统提示词后评测不降。旧指令在补偿模型已经不再有的弱点，留着会逼模型走冗余检查和僵硬序列。

方法叫 ablation：先删，再按可观测失败一条条加回。对立面是 accretion：每次犯错加一条。Cherny 的产品写法是 **任务 + 护栏 + 完成长什么样**，让模型自己选步骤。

「删 80%」绑定的是 Opus 5 的能力，不是可移植的删除比例。可移植的是 ablation 纪律，以及脚手架与模型能力成反比。

### 3.6 硬约束不写在散文里

社区与官方一致：CLAUDE.md 是建议；Hook、权限、静态检查才是强制。Git 署名、危险命令、格式化，该进 hook/settings 的不在提示词里喊。

Maestro 自己的诊断已经落到同一点：不变量只写在散文里时，失败路径（重试、暂停、空知识库）不会触发。

### 3.7 对「200 行」数字的校准

Alex Dunlop 2026-08 的证据综述指出：把「200 行」说成截断上限，是把 `MEMORY.md` 的硬帽套到了 `CLAUDE.md` 上。有单规则实验在 25–500 行之间看不到遵守率差。

本文采用的数字用法：

- **200 行**是官方软目标与社区预算，不是截断线。
- **真正的预算**是指令条数（约 150–200，其中宿主已占约 50）和「每行是否改变行为」。
- 内核目标 **40–60 行**对齐 HumanLayer / linux.do 的高信号实践，给 Kimi K3 留出系统提示词之后的名额。

### 3.8 调研对 Maestro 的直接推论

| 共识 | 对 Maestro 始终在线文件的含义 |
| --- | --- |
| 只放每轮都成立的规则 | Explore 教程、Knowledge 百科、Delegate 全文移出 |
| 短比全重要 | 源文件收到约 40–60 行；禁止用 `@` 把手册再展开进来 |
| 堆规则伤效果 | 删除 Coding Philosophy 口号；不把 SOLID / 开闭 / 依赖倒置写进每轮 |
| Karpathy 密度 | 留少改、不主动写文档、join、search 命令、完成标准 |
| 任务 + 护栏，不要 1 然后 2 然后 3 | 主文件只指路到 Skill，不写 Explore 逐步教程 |
| 脚手架 ∝ 1/模型能力 | Kimi K3 不清空；不清空不等于保留 270 行手册 |
| 硬约束进 Hook | Knowledge Gate 与「禁止直接写 specs/knowhow」从散文改成强制 |

---

## 4. 推荐方案

### 4.1 三层模型

```text
L0 始终在线（内核）     任务 + 护栏 + 完成长什么样 + 路由表
L1 Skill（按需）        编排 / 知识 / explore / delegate 的完整协议
L2 Hook / 代码（强制）  Gate、写保护、危险命令；失败可见
```

L0 所有平台共用一份 `kernel.md`，每端一份不超过约 15 行的 delta（Claude `Agent()` join、Grok `spawn_subagent` 白名单）。停止四份 250 行手册分叉复制。

### 4.2 L0 内核内容（目标稿）

始终在线只保留下面这类句子。下列为设计规格，落地时以源文件为准。

**护栏**

- 只改必须改的；不顺手重构、不扩范围。
- 不主动写文档、报告、总结；当前命令要求的 `report.md` 或声明过的 typed output 除外。
- 自己拉起的子代理，本轮必须 join 或 stop；禁止 fire-and-forget。
- 动项目文件前：`maestro search "<1-3 keywords>" --json`。空结果才继续发现。`git status` / Grep / 文件名搜索不满足这一条。
- 不直接写 `.workflow/specs/`、`.workflow/knowhow/`；入库走知识 Skill 给出的命令。

**路由**

- `/maestro`、`/maestro-next`、`/maestro-ralph` → 读对应 Skill 再执行。
- 知识治理（stage / review / promote / harvest）→ `maestro-knowledge`。
- 不确定入口、需要跨文件综合 → `maestro explore --help` 或 explore Skill；精确文本用 Grep。
- Delegate → `cat ~/.maestro/workflows/delegate-usage.md`，严格按 `~/.maestro/cli-tools.json`。

**平台 delta 示例（Grok）**

- 只使用宿主的 `spawn_subagent`；不要调用不存在的 Codex agent API。
- 没有 `update_plan` / `create_task`；进度写在 Run 产物里的 checklist。
- `create_goal` 仅在用户明确要求或步骤声明 `goal: true` 时使用。

**中文（选装）**

保持 `chinese-response.md` 约 26 行，单独 section 注入。不并进内核，避免未选 chinese 的用户被强制中文。

### 4.3 L1 Skill 调整

| 内容 | 动作 |
| --- | --- |
| Session / Run | 保持现有 Skill 为协议真源；主文件不复述状态机 |
| Knowledge | 去掉 `maestro-knowledge` 的 `disable-model-invocation: true`；主文件只留一行路由 |
| Explore | 新增薄 Skill，或把 FIND+SCOPE 教程放到 `maestro explore --help` 的权威文案，主文件删除教程 |
| Delegate | 删除 Claude `@` 展开；与 Grok 一样按需 `cat` |
| Coding philosophy | 退出始终在线。需要时读 `coding-philosophy.md`，不在启动时注入 |

### 4.4 L2 Hook

主文件 ablation 之后，把现在只写在散文里的保证接到强制层。可先告警，再 fail-closed。

- Knowledge Gate：对「读/改项目文件」的工具，本轮尚未 `maestro search` 时发出可见信号；空库不再静默成功。
- 写保护：非白名单命令直接写 `.workflow/specs/`、`.workflow/knowhow/` 时拦截或告警。
- Git 署名、危险命令继续留在 settings/hook，不写回提示词。

子代理 join 不走 Stop hook 去「等待仍在跑的 agent」（Claude Code #58637 会变成死循环）。Join 仍是模型职责，主文件保留这一条硬轨。

### 4.5 安装与作者规范

- `*-instructions.md` 改为「内核 + 平台 delta」；安装器仍 tag-inject，段落标记不变，便于 `--force` 更新且保留用户段外正文。
- Claude 安装目标维持 `CLAUDE.md` 的 Maestro 段。不把同一手册再写进 `~/.claude/rules/`——没有任务条件的 rules 是第二份始终在线文件。
- Grok 维持 `rules/maestro.md` 落点（与用户 `AGENTS.md` 分离），但源文件必须瘦到内核。换落点不是减负。
- 给 `workflows/*-instructions.md` 加行数门禁（建议：内核 >80 行 CI 失败）。
- 改 `instruction-authoring-guide.md`：允许「Hook 强制、提示词只指路」。删除「hooks handle it → ALWAYS search」这条反模式。

### 4.6 明确不采用的做法

- 把 Grok「从 AGENTS.md 挪到 rules/」当成优化完成。
- 给 Claude 再堆一份无路径条件的 `~/.claude/rules/` 手册。
- 照抄 Opus 5 清空系统提示词。
- 与用户「工作原则」四端同步混在同一次提交。
- 用 `@` 把 `delegate-usage.md`、`search-tools.md`、`coding-philosophy.md` 在启动时展开。
- 规则被忽略时加粗、加 ALWAYS、再写一遍。

### 4.7 与 content-layout-plan 的衔接

`guide/content-layout-plan.md` 把 `coding-philosophy.md`、`delegate-usage.md` 标成「CLAUDE.md 全局引用、会话启动交付」。按本文，这两份改为按需读取：类型仍是跨项目准则，加载者从「CLAUDE.md 启动展开」改为「内核一行索引 + 模型/命令按需读文件」。协议文档（`run-mode.md`）继续由 Run create/brief 注入，不进始终在线。

---

## 5. 推进计划

范畴：`maestrogrok/repo`。通用修复从 origin/master 切 `pr/*` cherry-pick，不带 fork 积压，向 catlog22/maestro-flow 提 PR。

一次只做一列验证。用户原则 ablation 另走 `user-prompts-update`。

### 5.1 阶段 0 — 量测与门禁（不改行为）

**做：** 统计 `workflows/*-instructions.md` 与 chinese 的行数；列出 Claude `@` 展开文件；给源文件加「内核行数」CI（可先 warn）。

**验证：** CI 能打印四份指令文件行数；文档中的行数与仓库一致。

### 5.2 阶段 1 — 源文件 ablation（主收益）

**做：**

1. 抽出共享 `kernel.md`（或等价结构），四份 `*-instructions.md` 改为内核 + 平台 delta。
2. 删除 Coding Philosophy、Explore 教程、Knowledge 百科、Context Requirements 仪式。
3. Claude 去掉对 `delegate-usage.md` / `search-tools.md` 的 `@`；改为 `cat` 指针。
4. 保留：少改、不主动写文档、join、5 行 search Gate、路由表、平台工具陷阱、chinese 选装。

**验证：**

- 源文件内核 ≤80 行（目标 40–60）；chinese 仍约 26 行且独立 section。
- `maestro install --force` 后：`~/.claude/CLAUDE.md`、`~/.grok/rules/maestro.md`、Cursor `AGENTS.md` 的 Maestro 段不再含 FIND+SCOPE 长教程和 promote 资格长文。
- 用户 `AGENTS.md` / `CLAUDE.md` 段外正文仍在。
- 现有 inject / grok-legacy-agents / install-executor 测试全绿。
- 抽检：简单改文件任务不再被手册带着走「先找 3 个同类 / 先写分解」。

### 5.3 阶段 2 — Knowledge Skill 可被模型调用

**做：** 去掉 `maestro-knowledge` 的 `disable-model-invocation: true`（或改为模型可发现的描述）。内核只留一行「知识入库走这个 Skill」。

**验证：** 用户未提知识治理时，上下文不再出现 stage/promote 长文；用户提到审查候选 / harvest 时会读该 Skill。

### 5.4 阶段 3 — Explore 从主文件迁出

**做：** 薄 Skill 或把教程收口到 `maestro explore --help`。主文件只留「不确定入口才用 explore，精确文本用 Grep」。

**验证：** 精确符号搜索走 Grep；跨文件综合才会打开 explore 说明。

### 5.5 阶段 4 — Hook 把 Gate 从装饰变成信号

**做：** `spec-injector` / 知识相关 PreToolUse：空库或本轮未 search 时告警（先 fail-open + 可见，再视误报收紧）。非白名单写 `.workflow/specs|knowhow` 告警或拦截。

**验证：** 空库不再静默当成功；未 search 就改项目文件时，宿主能看到信号。不把 Stop hook 改成等待子代理。

**依赖：** 阶段 1 已把长手册删掉，否则 Hook 告警会和散文双重指挥。

### 5.6 阶段 5 — 作者规范与上游

**做：** 改 `instruction-authoring-guide.md`；更新 `content-layout-plan.md` 类型 8 的加载者；从干净 master 切 `pr/*` 向上游提。PR 范围限定阶段 1–3 的提示词层，Hook（阶段 4）可另开 PR。

**验证：** 镜像 lint、install 测试、行数门禁全绿；上游 PR 不夹带 fork 积压。

### 5.7 风险与回滚

| 风险 | 处理 |
| --- | --- |
| Kimi K3 丢掉 search / join | 内核保留这两条；阶段 1 后用真实会话抽检，失败只加回那一条 |
| 知识治理没人读 Skill | 阶段 2 打开模型调用；仍失败再把 5 行 Gate 扩成 10 行，不把百科加回 |
| `--force` 安装盖掉用户段内改动 | 继续只用 tag 段；用户原则在段外 |
| Hook 误伤只读浏览 | 阶段 4 先告警；只对写工具收紧 |

回滚：还原 `workflows/*-instructions.md` 并 `maestro install --force` 对应组件。tag 段整段替换，段外用户正文不受影响。

### 5.8 建议的第一次落地范围

只做阶段 1（源文件 ablation + 去掉 Claude `@` 大文件）。不碰 Hook、不改用户工作原则、不改 Skill 的 `disable-model-invocation`。一次安装即可让 Claude、Grok、Cursor 的 Maestro 段同时变瘦。
