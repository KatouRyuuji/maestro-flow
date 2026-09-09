# 分支账本

本文件是本 fork 的分支、远程、主干和上游 PR 的单一事实来源。每次分支或 PR 有变动，同一改动里更新本文件。

配套流程：仓库根目录 `branch-hygiene.SKILL.md`（Grok 加载入口：`.grok/skills/branch-hygiene/SKILL.md`）。

账本核对基准：2026-09-09。

---

## 仓库身份

| 项 | 当前值 |
|---|---|
| Git 根目录 | `D:\PersonalProject\maestrogrok\repo` |
| 外层工作区 | `D:\PersonalProject\maestrogrok`（无独立 `.git`） |
| Fork | https://github.com/KatouRyuuji/maestro-flow |
| 上游 | https://github.com/catlog22/maestro-flow |
| Fork 默认分支 | `master` |
| 当前检出 | `master` |

## 远程

| 远程名 | 角色 | fetch | push |
|---|---|---|---|
| `fork` | 自己的 GitHub fork | `https://github.com/KatouRyuuji/maestro-flow.git` | 同 fetch |
| `origin` | 上游 `catlog22/maestro-flow` | `https://github.com/catlog22/maestro-flow.git` | `no_push`（只拉不合） |

日常推送目标是 `fork`。上游合入走 GitHub PR。

## 两条工作线

本仓库同时维护两条独立历史，提交集合不同。

### 产品主干

- 分支：本地 `master` = 远程 `fork/master`
- 跟踪：`fork/master`
- 相对上游 `origin/master`：超前 40 个 commit，落后 0
- 尖端：`acf1accb` — `docs: 增加分支账本与 branch-hygiene skill`
- 用途：本机安装、Grok 适配完整产品（含 child-scope、覆盖脚本、INSTALL.md 等）
- 本账本与 skill 只存在于这条线上

### 上游投稿线

- 基线：`origin/master`（当前尖端 `bf4a4f54`，`chore(release): prepare v0.5.86`）
- 命名：`pr/<type>-<topic>`
- 与产品主干：投稿 tip **不是** 产品 `master` 的祖先；内容从产品线按主题切出后重新提交
- 推送：`git push -u fork HEAD`
- 开 PR：`gh pr create --repo catlog22/maestro-flow --head KatouRyuuji:<branch> --base master`

## 产品主干

| 项 | 当前值 |
|---|---|
| 本地 | `master` @ `acf1accb` |
| 远程 | `fork/master`（推送本尖端后与本地一致） |
| 上游对照 | `origin/master` @ `bf4a4f54`（v0.5.86） |
| 合入上游方式 | 不直接 push `origin`；用投稿线开 PR |

同步上游进产品主干的现行做法：

```text
git fetch origin
git checkout master
git merge origin/master
git push fork master
```

然后更新本文件「产品主干」与「账本核对基准」。

---

## 活分支

### 产品

| 本地分支 | 跟踪 | 尖端 | 用途 |
|---|---|---|---|
| `master` | `fork/master` | `acf1accb` | 产品主干 |

### 上游投稿（Open PR）

| 本地分支 | 跟踪 | 尖端 | 相对 `origin/master` | 上游 PR | 状态 |
|---|---|---|---|---|---|
| `pr/fix-kg-sync-and-runtime-bugs` | `fork/pr/fix-kg-sync-and-runtime-bugs` | `59637a33` | 超前 1 | [#35](https://github.com/catlog22/maestro-flow/pull/35) | Open |
| `pr/fix-http-hooks` | `fork/pr/fix-http-hooks` | `7879df90` | 超前 1 | [#36](https://github.com/catlog22/maestro-flow/pull/36) | Open |
| `pr/feat-grok-build-cli` | `fork/pr/feat-grok-build-cli` | `2c9ad4f9` | 超前 1 | [#37](https://github.com/catlog22/maestro-flow/pull/37) | Open |
| `pr/feat-goal-native-host` | `fork/pr/feat-goal-native-host` | `a70d1bea` | 超前 2（含 #37） | [#38](https://github.com/catlog22/maestro-flow/pull/38) | Open |

投稿依赖：#38 叠在 #37 上。建议合入顺序：#35 与 #36 可并行，然后 #37，然后 #38。

Fork 远程上与上表对应的分支：`master`、`pr/fix-kg-sync-and-runtime-bugs`、`pr/fix-http-hooks`、`pr/feat-grok-build-cli`、`pr/feat-goal-native-host`。

### 本地遗留

| 本地分支 | 跟踪 | 尖端 | 说明 |
|---|---|---|---|
| `feat/grok-cli-support` | `origin/master`（ahead 10, behind 42） | `e59e6eb3` | 已关闭 PR [#29](https://github.com/catlog22/maestro-flow/pull/29) 的本地残留；fork 远程已无此分支；产品内容在 `master` |

---

## 已关闭的上游 PR（仍记在账本，便于对照投稿线）

| PR | 状态 | 合入 |
|---|---|---|
| [#26](https://github.com/catlog22/maestro-flow/pull/26) | Closed | 否 |
| [#28](https://github.com/catlog22/maestro-flow/pull/28) | Closed | 否 |
| [#29](https://github.com/catlog22/maestro-flow/pull/29) | Closed | 否 |

---

## 账本字段

每个活分支在表中保持这些列：本地名、跟踪远程、尖端短哈希、用途或 PR 链接与状态。

投稿分支额外保持：相对 `origin/master` 的 ahead/behind、是否叠在其他投稿分支上。
