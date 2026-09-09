# 分支账本

本文件是分支状态的单一事实来源。用词以本节「用语」为准。每次分支或上游 PR 有变动，同一轮工作里更新本文件。

配套流程：仓库根目录 `branch-hygiene.SKILL.md`（Grok 加载入口：`.grok/skills/branch-hygiene/SKILL.md`）。

账本核对基准：2026-09-09。

---

## 用语

| 用语 | 含义 |
|---|---|
| 上游 | 官方仓库 https://github.com/catlog22/maestro-flow |
| 远端 | 自己 fork 的主分支 `KatouRyuuji/maestro-flow:master`（git：`fork/master`） |
| 本地 | 当前工作空间 `D:\PersonalProject\maestrogrok`（Git 根目录是其中的 `repo/`） |
| 分支 | 自己的 git 分支（专题分支、投稿分支等） |
| 提交 | 本地 `git commit` |
| 推送 | 把主分支送到远端：`git push fork master` |

默认工作在主分支 `master` 上进行。只有用户特别说明时才切到分支上工作。

---

## 仓库身份

| 项 | 当前值 |
|---|---|
| 本地 Git 根目录 | `D:\PersonalProject\maestrogrok\repo` |
| 上游 | https://github.com/catlog22/maestro-flow |
| 远端 | https://github.com/KatouRyuuji/maestro-flow 的 `master` |
| 当前检出 | `master` |

## Git 远程名对照

| git remote | 对应用语 | fetch | push |
|---|---|---|---|
| `fork` | 自己的 GitHub fork；其中的 `master` 即远端 | `https://github.com/KatouRyuuji/maestro-flow.git` | 同 fetch |
| `origin` | 上游 | `https://github.com/catlog22/maestro-flow.git` | `no_push` |

主分支 `master` 跟踪远端 `fork/master`。

---

## 主分支（默认工作处）

主分支同时是本地 `master` 与远端。当前尖端一致。

| 项 | 当前值 |
|---|---|
| 本地主分支 | `master` @ `a03565ec` — `docs: 账本与 skill 采用上游/远端/本地/分支/提交/推送用语` |
| 远端 | `fork/master` @ `a03565ec` |
| 上游主分支 | `origin/master` @ `bf4a4f54` — `chore(release): prepare v0.5.86` |
| 相对上游主分支 | 超前 42，落后 0 |
| 用途 | 完整产品（Grok 适配、安装落点、本账本与 skill） |

把上游主分支合进主分支的现行做法：

```text
git fetch origin
git checkout master
git merge origin/master
git push fork master
```

然后更新本节尖端、超前数量与核对基准。

本账本与 skill 只提交到主分支，并推送到远端。

---

## 分支

用户特别说明时才使用。投稿给上游的分支从上游主分支 `origin/master` 拉出，命名 `pr/<type>-<topic>`。

### 当前分支（Open 上游 PR）

| 分支 | 跟踪 | 尖端 | 相对上游主分支 | 上游 PR | 状态 |
|---|---|---|---|---|---|
| `pr/fix-kg-sync-and-runtime-bugs` | `fork/pr/fix-kg-sync-and-runtime-bugs` | `d42198e6` | 超前 2 | [#35](https://github.com/catlog22/maestro-flow/pull/35) | Open |
| `pr/fix-http-hooks` | `fork/pr/fix-http-hooks` | `7879df90` | 超前 1 | [#36](https://github.com/catlog22/maestro-flow/pull/36) | Open |
| `pr/feat-grok-build-cli` | `fork/pr/feat-grok-build-cli` | `2c9ad4f9` | 超前 1 | [#37](https://github.com/catlog22/maestro-flow/pull/37) | Open |
| `pr/feat-goal-native-host` | `fork/pr/feat-goal-native-host` | `a70d1bea` | 超前 2（含 #37） | [#38](https://github.com/catlog22/maestro-flow/pull/38) | Open |

#38 叠在 #37 上。合入顺序：#35 与 #36 可并行，然后 #37，然后 #38。

GitHub fork 上除远端（`master`）外还有上表四条同名引用，供上游 PR 取头。

### 本地遗留分支

| 分支 | 跟踪 | 尖端 | 说明 |
|---|---|---|---|
| `feat/grok-cli-support` | `origin/master`（ahead 10, behind 42） | `e59e6eb3` | 已关闭上游 PR [#29](https://github.com/catlog22/maestro-flow/pull/29)；GitHub fork 已无此引用；内容在主分支 |

---

## 已关闭的上游 PR

| PR | 状态 | 合入上游 |
|---|---|---|
| [#26](https://github.com/catlog22/maestro-flow/pull/26) | Closed | 否 |
| [#28](https://github.com/catlog22/maestro-flow/pull/28) | Closed | 否 |
| [#29](https://github.com/catlog22/maestro-flow/pull/29) | Closed | 否 |

---

## 账本字段

主分支行保持：本地尖端、远端尖端、上游主分支尖端、超前/落后。

每个分支行保持：名称、跟踪、尖端、用途或上游 PR 链接与状态。投稿分支额外保持相对上游主分支的 ahead/behind、叠放关系。
