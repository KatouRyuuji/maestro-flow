---
title: "安装指南"
icon: "📦"
---

Maestro-Flow 安装分为全局 CLI 安装和项目初始化两步。

---

## 快速安装

```bash
# 1. 安装全局 CLI
npm install -g maestro-flow

# 2. 初始化项目（在项目根目录执行）
maestro install
```

**前置要求**：
- Node.js ≥ 18
- Claude Code CLI（必需）
- Codex CLI / Gemini CLI（可选，用于多 agent 工作流）

---

## 安装流程

`maestro install` 执行以下步骤：

1. **检测项目状态** — 空项目 / 已有代码 / 已有 .workflow/
2. **选择组件** — 交互式组件选择界面
3. **选择安装模式** — 全局 (~/.maestro/) 或项目级 (.workflow/)
4. **复制文件** — 按组件定义复制到目标位置
5. **生成 manifest** — 记录已安装组件，支持增量更新

### 加法语义（v0.5.50+）

安装采用**加法语义**——只添加、不删除。已存在的组件文件保留不覆盖，manifest 记录 `knownComponentIds` 跟踪所有曾安装过的组件。

关键机制：
- **安装锁** — 使用 lockfile 防止并发安装互相覆盖
- **原子写** — manifest 写入采用 write-tmp-then-rename，避免断电/崩溃导致 manifest 损坏
- **幂等安装** — 重复运行 `maestro install` 安全无副作用

---

## 组件分组

从 v0.5.32 起，安装组件从 53 个独立条目整合为 25 个分组，提供更简洁的选择体验。

### 核心组件（默认选中）

| 分组 | 说明 | 文件数 |
|------|------|--------|
| **commands** | 核心 slash 命令 | ~30 |
| **hooks** | 自动化钩子 | ~5 |
| **workflows** | 工作流脚本 | ~10 |
| **specs** | 规范模板 | 7 |

### 可选技能包

> 自 v0.5.61 起 skill 面大幅精简：20 个零使用团队/辅助 skill 已删除，
> 原 skills-extra-team / skills-meta 成员或并入核心、或移除。现仅保留 1 个实质可选包。

#### skills-scholar（10 个学术技能，选装）

学术写作与研究的端到端技能链，默认不安装（源自 `optional/skills/`），用 `maestro install toggle` 启用：

| 技能 | 说明 |
|------|------|
| scholar-ideation | 研究选题 |
| scholar-writing | 论文写作（端到端） |
| scholar-experiment | 实验分析 |
| scholar-citation-verify | 引文核验 |
| scholar-anti-ai-writing | 去 AI 痕迹 |
| scholar-latex-organizer | LaTeX 整理 |
| scholar-review | 论文评审 |
| scholar-rebuttal-pro | 审稿回复 Pro |
| scholar-thesis-docx | 学位论文排版 |
| scholar-publish | 投稿准备 |

#### skills-extra-team / skills-meta（遗留空 bundle）

仅为旧清单回放迁移保留的 no-op 分组，不再安装任何技能。原成员去向：

- `team-arch-opt`、`team-issue`、`team-perf-opt` → 转为内置团队技能（skills-team）
- `skill-generator`、`skill-simplify`、`skill-iter-tune`、`skill-tuning`、`workflow-skill-designer` → 并入核心 `skills` 组件（始终安装）
- 其余 17 个 team-* 及 `prompt-generator`、`delegation-check`、`codify-to-knowhow`、`insight-challenge` → 已删除

### 内置团队技能（始终安装）

以下 8 个团队技能随核心组件（`skills-team`）自动安装，无需单独选择：

- team-arch-opt
- team-coordinate
- team-issue
- team-lifecycle-v4
- team-perf-opt
- team-review
- team-swarm
- team-testing

另有 6 个核心元技能随 `skills` 组件始终安装：maestro-help、skill-generator、
skill-iter-tune、skill-simplify、skill-tuning、workflow-skill-designer。

### 逐个启用/禁用技能（install toggle）

技能包按组安装后，可用 `maestro install toggle` 对单个技能、命令或 agent 精细控制：

```bash
# 交互式 TUI — 勾选/取消单个项目
maestro install toggle

# 列出所有项目及状态（✓ 启用 / ✗ 禁用 / · 未安装）
maestro install toggle --list

# 按类型过滤
maestro install toggle --type skill --list

# 非交互式启用/禁用（逗号分隔）
maestro install toggle --type skill --enable scholar-writing,scholar-review
maestro install toggle --type skill --disable scholar-latex-organizer

# 项目级安装作用域
maestro install toggle --path ./my-project --list
```

`--type` 取值：`command`、`skill`、`agent`。状态写入 manifest，支持增量更新与跨项目隔离。

---

## 安装模式

### 全局模式（推荐）

安装到 `~/.maestro/`，所有项目共享：

```bash
maestro install --global
```

适合：个人开发机，多项目共享配置

### 项目模式

安装到项目目录 `.workflow/`，仅当前项目生效：

```bash
maestro install --path <dir>
```

适合：团队协作，项目特定配置

---

## 从旧版本迁移

### v0.5.32+ 自动迁移

旧版本的个别 skill ID 会自动映射到新分组 ID：

| 旧 ID | 新 ID |
|--------|-------|
| team-arch-opt / team-issue / team-perf-opt | skills-team（已转为内置） |
| team-brainstorm 等已删除 team 技能 | skills-extra-team（遗留空 bundle，无操作） |
| prompt-generator / delegation-check | skills-meta（遗留空 bundle，无操作） |
| scholar-ideation 等 scholar-* | skills-scholar |
| ... | ... |

迁移在安装时自动执行，无需手动操作。

### 手动迁移

如需手动更新 manifest：

```bash
# 查看当前安装状态
maestro install toggle --list

# 强制重新安装
maestro install --force
```

---

## 更新

```bash
# 检查更新
maestro update

# 预览变更（不实际应用）
maestro update --dry-run

# 强制覆盖
maestro update --force
```

---

## 卸载

```bash
# 交互式卸载
maestro uninstall

# 批量卸载（跳过确认）
maestro uninstall --yes
```

卸载时会：
1. 移除已安装的组件文件
2. 清理 manifest 记录
3. 保留 `.workflow/` 中的项目数据（specs、knowhow 等）

---

## 网络代理

如需通过代理安装，在 `~/.maestro/cli-tools.json` 中配置：

```json
{
  "proxy": {
    "enabled": true,
    "httpProxy": "http://127.0.0.1:7890",
    "noProxy": "127.0.0.1,localhost"
  }
}
```

---

## 常见问题

### 安装卡住

1. 检查网络连接
2. 尝试配置代理（见上）
3. 使用 `--verbose` 查看详细日志

### 组件缺失

```bash
# 重新安装
maestro install --force

# 检查组件状态
maestro install toggle --list
```

### 权限错误

全局安装可能需要管理员权限：
```bash
# macOS/Linux
sudo npm install -g maestro-flow

# Windows（以管理员身份运行）
npm install -g maestro-flow
```

---

## 相关命令

```bash
# 安装管理
maestro install [--global|--path <dir>] [--force]
maestro uninstall [--yes]
maestro update [--dry-run] [--force]

# 版本信息
maestro --version
```
