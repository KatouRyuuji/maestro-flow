# 分支账本

本文件是分支状态的单一事实来源。用词以本节「用语」为准。每次分支或上游 PR 有变动，同一轮工作里更新本文件。

配套流程：仓库根目录 `branch-hygiene.SKILL.md`（Grok 加载入口：`.grok/skills/branch-hygiene/SKILL.md`）。

账本核对基准：2026-09-10。

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

默认工作在主分支 `master` 上进行。只有用户特别说明时才切到分支上工作。默认「拉新」指把远端合进本地主分支（`git pull --ff-only fork master`）。只有用户说「同步上游」时才把上游主分支合进主分支。

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
| 本地主分支 | `master` @ `aaf855ba` — `fix: Windows hook argv0 避开 shell 元字符，descriptor 回收在 spawn lock 内完成` |
| 远端 | `fork/master` @ `aaf855ba` |
| 上游主分支 | `origin/master` @ `9834a145` — `Merge pull request #38 from KatouRyuuji/pr/feat-goal-native-host` |
| 相对上游主分支 | 超前 50，落后 9 |
| 用途 | 完整产品（Grok 适配、安装落点、本账本与 skill） |

落后 9 来自上游合入 #35–#38 的 GitHub merge commit，不是缺产品提交。要把这些 merge commit 接进主分支，等用户说「同步上游」再执行：

```text
git fetch origin
git checkout master
git merge origin/master
git push fork master
```

然后更新本节尖端、超前/落后数量与核对基准。

本账本与 skill 只提交到主分支，并推送到远端。

---

## 分支

用户特别说明时才使用。投稿给上游的分支从上游主分支 `origin/master` 拉出，命名 `pr/<type>-<topic>`。

### 当前分支（Open 上游 PR）

| 分支 | 跟踪 | 尖端 | 相对上游主分支 | 上游 PR | 状态 |
|---|---|---|---|---|---|
| `pr/fix-kg-root-daemon` | `fork/pr/fix-kg-root-daemon` | `8f1313c4` | 超前 2 | [#39](https://github.com/catlog22/maestro-flow/pull/39) | Open |
| `pr/fix-windows-test-gate` | `fork/pr/fix-windows-test-gate` | `c6616b8f` | 超前 2 | [#40](https://github.com/catlog22/maestro-flow/pull/40) | Open |

两条投稿分支都从 `origin/master` 拉出，文件无重叠，可并行审阅。#40 不含 fork 专用的 `scripts/__tests__/install-grok.test.mjs`。

GitHub fork 上除远端（`master`）外还有上表两条同名引用，供上游 PR 取头。

### 本地遗留分支

| 分支 | 跟踪 | 尖端 | 说明 |
|---|---|---|---|
| `feat/grok-cli-support` | `origin/master`（ahead 10, behind 51） | `e59e6eb3` | 已关闭上游 PR [#29](https://github.com/catlog22/maestro-flow/pull/29)；GitHub fork 已无此引用；内容在主分支 |

---

## 已关闭的上游 PR

| PR | 状态 | 合入上游 |
|---|---|---|
| [#26](https://github.com/catlog22/maestro-flow/pull/26) | Closed | 否 |
| [#28](https://github.com/catlog22/maestro-flow/pull/28) | Closed | 否 |
| [#29](https://github.com/catlog22/maestro-flow/pull/29) | Closed | 否 |
| [#35](https://github.com/catlog22/maestro-flow/pull/35) | Merged | 是 |
| [#36](https://github.com/catlog22/maestro-flow/pull/36) | Merged | 是 |
| [#37](https://github.com/catlog22/maestro-flow/pull/37) | Merged | 是 |
| [#38](https://github.com/catlog22/maestro-flow/pull/38) | Merged | 是 |

---

## 账本字段

主分支行保持：本地尖端、远端尖端、上游主分支尖端、超前/落后。

每个分支行保持：名称、跟踪、尖端、用途或上游 PR 链接与状态。投稿分支额外保持相对上游主分支的 ahead/behind、叠放关系。
