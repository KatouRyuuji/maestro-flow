---
name: branch-hygiene
description: 本 fork 的分支管理、追踪与账本更新。涉及 git 分支、fork 同步、上游 PR、主干时使用。
---

# 分支卫生

本仓库 Git 根目录是 `repo/`（即本文件所在目录）。外层 `D:\PersonalProject\maestrogrok` 没有 `.git`。

权威状态在同目录 `BRANCHES.md`。本 skill 描述现行流程。动手前先读 `BRANCHES.md` 并 `git fetch origin`、`git fetch --prune fork`。

## 何时用

用户或任务涉及：分支、主干、fork、上游 PR、同步 `catlog22/maestro-flow`、拆分投稿、清理本地分支。

## 两条工作线

| 线 | 分支 | 基线 | 推送 |
|---|---|---|---|
| 产品 | `master` | 可合并 `origin/master` | `fork` |
| 投稿 | `pr/<type>-<topic>` | 从最新 `origin/master` 拉出 | `fork`，再向 `catlog22/maestro-flow` 开 PR |

产品线保存完整本地产品。投稿线每个 PR 一个主题，从上游 tip 重新落盘，与产品线历史分开。

`BRANCHES.md`、`branch-hygiene.SKILL.md`、`.grok/skills/branch-hygiene/` 只提交到产品 `master`。

## 远程

| 名 | 含义 | 操作 |
|---|---|---|
| `fork` | `KatouRyuuji/maestro-flow` | fetch + push |
| `origin` | `catlog22/maestro-flow` | 只 fetch；push URL 为 `no_push` |

`master` 跟踪 `fork/master`。

## 产品主干上的工作

1. `git checkout master`
2. 改代码并提交
3. `git push fork master`
4. 更新 `BRANCHES.md` 产品主干尖端与核对基准
5. 提交账本（可与功能同一 commit，或紧随的 `docs:` commit）

从上游更新产品主干：

```text
git fetch origin
git checkout master
git merge origin/master
git push fork master
```

然后改 `BRANCHES.md` 里上游尖端、超前数量、核对基准。

## 开上游 PR

1. `git fetch origin`
2. `git checkout -B pr/<type>-<topic> origin/master`
3. 只纳入该主题的文件或补丁
4. 提交
5. `git push -u fork HEAD`
6. `gh pr create --repo catlog22/maestro-flow --head KatouRyuuji:pr/<type>-<topic> --base master`
7. 在 `BRANCHES.md` 活分支表增加一行（跟踪、尖端、ahead、PR 编号与 Open）

投稿分支从 `origin/master` 生长。依赖另一投稿 PR 时，从那条 `pr/*` 拉出，并在账本写明叠放关系。

## 投稿 PR 合入或关闭之后

1. `git fetch origin` 与 `git fetch --prune fork`
2. 账本该行改为已合入或已关闭（Closed 表），或从活分支表移除
3. 删除本地分支：`git branch -d pr/<name>`
4. 删除 fork 远程分支：`git push fork --delete pr/<name>`
5. 需要时把上游新 tip 合并进产品 `master`（见上）

## 本地遗留分支

无 fork 远程、无 Open PR 的专题分支记在 `BRANCHES.md`「本地遗留」。产品内容已在 `master` 上时，删除该本地分支并从表中去掉。

## 每次 git 操作后的账本核对

在同一轮工作结束前执行，并把结果写回 `BRANCHES.md`：

```text
git fetch origin
git fetch --prune fork
git status -sb
git branch -vv
git rev-list --left-right --count origin/master...master
gh pr list --repo catlog22/maestro-flow --author @me --state all --limit 15
```

核对项：当前检出、`master` 与 `fork/master` 是否同尖端、每个 `pr/*` 的 PR 编号与 Open/Closed/Merged、相对 `origin/master` 的 ahead/behind、fork 远程分支列表与账本一致。

## 提交说明

账本与 skill 的提交信息用中文，形式 `docs: …`。功能改动可与账本更新放在同一 commit。
