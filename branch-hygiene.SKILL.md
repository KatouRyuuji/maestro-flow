---
name: branch-hygiene
description: 按「上游 / 远端 / 本地 / 分支 / 提交 / 推送」管理本仓库。默认在主分支工作。涉及主干、fork、上游 PR 时使用。
---

# 分支卫生

权威状态在同目录 `BRANCHES.md`。动手前读取该文件，并执行 `git fetch origin` 与 `git fetch --prune fork`。

## 用语

| 用语 | 含义 | 现行对应 |
|---|---|---|
| 上游 | 官方仓库 | `origin` → `catlog22/maestro-flow` |
| 远端 | 自己 fork 的主分支 | `fork/master` |
| 本地 | 当前工作空间 | `D:\PersonalProject\maestrogrok`，Git 根为 `repo/` |
| 分支 | 自己的 git 分支 | `pr/*` 等；用户特别说明时才用 |
| 提交 | 本地 commit | `git commit` |
| 推送 | 送到远端 | `git push fork master` |

默认在主分支 `master` 上工作。切到分支、向 GitHub fork 发布专题引用、向上游开 PR，都要用户特别说明。

## 何时用

任务涉及：主分支、远端、上游、分支、提交、推送、上游 PR、同步官方仓库、更新 `BRANCHES.md`。

## 默认流程（主分支）

1. `git checkout master`
2. 改文件并提交
3. 推送：`git push fork master`
4. 更新 `BRANCHES.md` 主分支尖端与核对基准
5. 账本变更再提交，再推送（可与功能同一提交）

`BRANCHES.md`、`branch-hygiene.SKILL.md`、`.grok/skills/branch-hygiene/` 只进入主分支，并推送到远端。

## 把上游合进主分支

用户要求同步官方仓库时：

```text
git fetch origin
git checkout master
git merge origin/master
git push fork master
```

然后更新 `BRANCHES.md` 的上游尖端、超前数量、核对基准，提交并推送。

## 分支上的工作（需特别说明）

1. `git fetch origin`
2. `git checkout -B pr/<type>-<topic> origin/master`
3. 只纳入该主题的文件，提交
4. 把该分支发到 GitHub fork 同名引用：`git push -u fork HEAD`
5. `gh pr create --repo catlog22/maestro-flow --head KatouRyuuji:pr/<type>-<topic> --base master`
6. 在 `BRANCHES.md` 分支表增加一行

步骤 4 是发布分支引用，供上游 PR 取头；用语里的「推送」专指更新远端（fork 的 `master`）。

依赖另一条投稿分支时，从那条 `pr/*` 拉出，并在账本写明叠放。

## 上游 PR 合入或关闭之后

1. `git fetch origin` 与 `git fetch --prune fork`
2. 更新 `BRANCHES.md` 对应行
3. `git branch -d pr/<name>`
4. `git push fork --delete pr/<name>`
5. 用户要求时，把上游主分支合进主分支并推送

## 本地遗留分支

无 GitHub fork 引用、无 Open 上游 PR 的分支记在 `BRANCHES.md`「本地遗留分支」。内容已在主分支上时，删除该分支并从表中去掉。

## 每轮结束前的核对

把结果写回 `BRANCHES.md`：

```text
git fetch origin
git fetch --prune fork
git status -sb
git branch -vv
git rev-list --left-right --count origin/master...master
gh pr list --repo catlog22/maestro-flow --author @me --state all --limit 15
```

核对：检出是否主分支（除非本轮特别说明在分支上）、本地主分支与远端是否同尖端、各分支的上游 PR 状态、相对上游主分支的 ahead/behind、fork 远程引用与账本一致。

## 提交说明

账本与 skill 的提交信息用中文，形式 `docs: …`。功能改动可与账本更新放在同一提交里，然后推送。
