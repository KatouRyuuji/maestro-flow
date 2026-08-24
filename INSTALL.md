# Maestro Grok 适配版安装指南

本仓库是 maestro-flow 的 **Grok Build** 适配层：先装官方 `maestro-flow@0.5.82`，再叠本项目的按文件补丁，使 Grok 成为一等宿主与 delegate 后端。

产品级安装说明（组件、平台、toggle、profile）见 `repo/guide/install-guide.md`。

---

## 应用场景

1. 已经（或先）全局安装官方包：`npm install -g maestro-flow@0.5.82`
2. 再在本仓库跑安装脚本，把本项目补丁叠到那个官方目录

官方版本必须正好是 `0.5.82`。不一致会失败并提示你手装匹配版本，**不会** `npm i -g` 降级。源码比编译产物新时，一键脚本会先 `npm run build` 再覆盖。

---

## 最短路径

在**要写入项目资产的目录**跑（一般是你的项目根；本适配仓库则是仓库根）。不要 `cd repo/` 再跑：项目 `.grok/` 跟调用时的 cwd，不是脚本所在目录。

官方包已经是 `0.5.82`、补丁已经叠上、只缺 `.grok/rules/maestro.md` 时，也可以直接再跑一次。脚本会再覆盖一遍（幂等），然后跑 `maestro install` 写资产。

```powershell
# Windows（在本仓库根即可）
.\install.ps1
# 写到别的项目：
.\install.ps1 --path D:\path\to\your-project
```

```bash
# macOS / Linux
./install.sh
./install.sh --path /path/to/your-project
```

按提示确认即可。脚本会：检查官方 `maestro-flow` 版本 → 叠 Grok 按文件覆盖 → 写全局 MCP / 宿主资产 → 给调用方当前目录（或 `--path`）写 `.grok/`。

官方包未装、或版本不等于本仓库（当前 `0.5.82`）会失败并提示手动安装，**不会** `npm i -g` 自动降级。

常用标志：`--dry-run` 只检查不写盘；`-y` 跳过确认；`--rebuild` 强制重编译；`--path <dir>` 覆盖项目资产目录。

升级官方包之后覆盖会被冲掉，再跑一次本脚本即可。

---

## 前置要求

| 项 | 要求 | 缺了会怎样 |
|----|------|------------|
| Node.js | 能跑脚本即可装覆盖；推荐 ≥ 22.19（`repo/package.json` `engines.node`） | **没有 Node 或低于 22** 会停。22.14 这类 22.x 旧补丁只警告，Grok 覆盖仍装 |
| npm | 能执行 `npm install -g` | 没有 npm 会停 |
| 官方 Maestro | 必须已安装且版本等于本仓库（当前 `0.5.82`） | 未安装或版本不一致会失败并提示手动安装；**不会** `npm i -g` 降级 |
| Grok Build CLI | [官方安装](https://docs.x.ai/build/overview)，然后 `grok login` 或设置 `XAI_API_KEY` | 脚本不代装，只警告；装完才能派活 |

```bash
# macOS / Linux
curl -fsSL https://x.ai/cli/install.sh | bash

# Windows PowerShell
irm https://x.ai/cli/install.ps1 | iex
```

Claude Code 不是硬依赖。只用 Grok 时勾选平台 `grok` 即可。

---

## 升级 Node.js（Windows）

本机若是 `v22.14.0` 这类低于 22.19 的版本：Grok 适配能装、能派活，但 **`maestro kg init` / `maestro search` 会因缺少 FTS5 失败**。要知识库，换官方安装包。

不要用 `winget upgrade OpenJS.NodeJS.LTS` 当默认方案——当前 LTS 包可能直接跳到 Node 24。本仓库要求是 **22.19+**，留在 22 线即可。

**推荐（锁定 Node 22）：**

1. 关掉 Cursor / Grok / 所有已打开的终端。
2. 开一个**新的** PowerShell（建议管理员）：

```powershell
winget install -e --id OpenJS.NodeJS.22
```

3. 若 winget 没有这个包，到 [https://nodejs.org](https://nodejs.org) 下载 **22.x** Windows 安装包，覆盖安装到现在的目录（一般是 `C:\Program Files\nodejs`）。
4. 再开一个新终端：

```powershell
node -v
npm -v
node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(':memory:'); d.exec('CREATE VIRTUAL TABLE t USING fts5(c)'); console.log('fts5: ok')"
```

期望：`node -v` 为 `v22.19.0` 或更高的 22.x；最后一行打印 `fts5: ok`。

5. 回到本仓库再跑 `.\install.ps1`（覆盖不用重做也能用；升完 Node 主要是为了知识库）。

**也可以升到 Node 24 LTS**（`engines` 允许 major > 22）：

```powershell
winget upgrade --id OpenJS.NodeJS.LTS -e
```

升完同样重开终端，跑上面的 `node -v` 和 FTS5 探测。

macOS / Linux：用 nvm 或 fnm 安装 22.19+，例如 `nvm install 22`。

---

## 脚本在做什么

1. **检查依赖** — Node、npm、FTS5、本仓库 `node_modules`、编译产物
2. **检查官方版本** — 全局 `maestro-flow` 是否等于本仓库版本；官方目录里有没有 Grok 覆盖
3. **检查 Grok CLI** — 能否找到 `grok`（不代装）
4. **模拟安装** — 列出将要执行的命令，不写盘
5. **确认安装** — 回车或 `y` 才真正执行；成功后剥离旧 `.grok/AGENTS.md` 的 Maestro 段，并提示未信任的文件夹

没有 Node 22+ / 没有 npm 会停在第 5 步，不改系统。Node 低于 22.19 或没有 FTS5 只警告。Grok CLI 缺失只警告，仍可先装覆盖。

---

## 分步安装（备用）

覆盖脚本只替换清单里的已编译文件（Grok adapter / 安装落点 / 本项目的 v3 hook 与知识可见性补丁），**不整树替换** `dist/` / Dashboard，也**不改**官方 `node_modules` 依赖。官方目录会留下 `.maestro-grok-overlay.json` 方便核对叠了哪些文件。官方版本不一致时直接失败。

PowerShell 里 `--components` 的逗号列表必须加引号，否则会被拆成多个参数。

```powershell
npm install -g maestro-flow@0.5.82
cd repo
npm install
npm run build
npm run build:dashboard
npm run apply-to-official -- -y
maestro install --force --global --components "workflows,prepare,ref,arch-kb,templates,overlays,grok-context,grok-md-chinese,grok-skills,grok-agents" --extra-mcp grok
maestro install --force --path "D:\PersonalProject\maestrogrok" --components "grok-context,grok-md-chinese,grok-skills,grok-agents"
```

`apply-to-official` 只做按文件覆盖。一键脚本会跑 `maestro install`，但**不会**自动安装或降级官方包。

---

## 安装之后做什么

**项目指令只写 `.grok/rules/maestro.md`**（全局对应 `~/.grok/rules/maestro.md`）。不要把 `~/.grok/AGENTS.md` 或 `.grok/AGENTS.md` 当成项目指令落点，也不写仓库根 `AGENTS.md`。

重装时若旧落点 `.grok/AGENTS.md` 里还有 `<!-- maestro:start -->` 段，安装器会剥掉 Maestro 段、保留你自己的正文；剥空则删除该文件。Grok 仍会加载 `~/.grok/AGENTS.md` 里剩下的用户规则，只是不再和第二份 `rules/maestro.md` 叠两套 Maestro。

| 落点 | 内容 |
|------|------|
| 调用方目录（或 `--path`）`.grok/rules/maestro.md` | 项目指令（Maestro 段，保留你原来的正文） |
| 同上 `.grok/skills/`、`.grok/agents/` | 项目技能 / Agent |
| `~/.grok/rules/maestro.md` | 全局指令（`--global`） |
| `~/.grok/skills/`、`~/.grok/agents/` | 全局技能 / Agent |
| `~/.grok/config.toml` | `[mcp_servers.maestro-tools]`，含 `delegate` |

这与 Grok 官方发现路径一致：`./.grok/skills/`（向仓库根上溯）和 `~/.grok/skills/`。

### 命令只教 v3

新读者只敲这一条主线。旧的 `session next` / `session done` 不要当入口。

```bash
maestro session open "<intent>" --id <slug>
maestro run next
maestro run complete --advance
maestro session complete
```

斜杠命令（`/maestro`、`/maestro-ralph`）内部走同一套 v3 生命周期。不要开新的 maestro session 去「试安装」。

MCP 段按节合并，只替换 `maestro-tools`。Grok 若把 `env` 改写成嵌套表，重装会整段替换，不留孤儿节。Windows 上 `command = "cmd"`、`args = ["/c", "maestro-mcp"]`。

```bash
grok inspect
grok mcp list
grok mcp doctor maestro-tools
maestro delegate "读 README 并总结" --to grok --mode analysis
```

项目级 MCP / hooks / 仓库内 `.grok/config.toml` 受 Grok 文件夹信任策略约束；本机默认把 `maestro-tools` 写到用户级 `~/.grok/config.toml`，不依赖信任目录。新开一轮 Grok 会话后才能看到刚写入的 MCP 工具。

当前目录若尚未信任（`grok inspect` 里 `projectTrusted` 为 false）：在该目录开一次交互 `grok`，出现提示时确认，或在 TUI 执行 `/hooks-trust`。安装脚本**不会**改 `~/.grok/trusted_folders.toml`。

---

## 安装逻辑（以 `repo/` 源码为准）

1. **没有 `--mode` 标志**。范围用 `--global` 或 `--path <dir>`。共享运行时始终在 `~/.maestro/`，`.workflow/` 是项目数据而不是安装目标。
2. **`--extra-mcp` 必须用真实目标 ID**：`cursor`、`qoder`、`trae`、`kiro`、`roo`、`vscode-copilot`、`gemini-cli`、`grok`。写成 `vscode` / `gemini` 不会命中。
3. **Grok 平台组件 ID**：`grok-context`、`grok-md-chinese`、`grok-skills`、`grok-agents`。
4. **delegate**：`--to grok`，执行 ID 前缀 `grk-`，默认模型 `grok-4.6`。prompt 走 `--prompt-file`。`maestro delegate message` 的 inject 会停掉当前 headless 轮次并以 `grok --continue` 重拉。Grok 已列入 `roleMappings` fallbackChain。MCP 工具 `delegate` 默认 mode 是 `analysis`，改文件必须显式 `mode=write`。Grok 项目指令只写 `.grok/rules/maestro.md`，不要 `.grok/AGENTS.md`，也不写仓库根 `AGENTS.md`。
5. **`npm update -g maestro-flow` 会冲掉覆盖**。再跑 `.\install.ps1` 即可。
6. **知识库 `maestro kg init`** 依赖本机 Node 的 SQLite FTS5。部分 Windows Node 发行版没有 `fts5` 模块；这不影响 Grok 安装与派活。
7. **旧 `.grok/AGENTS.md` 迁移**：写入 `rules/maestro.md` 时剥离旧文件里的 Maestro 段，不整文件删除用户正文。
8. **文件夹信任**：一键脚本只检测并提示，不自动写入 `trusted_folders.toml`。

---

## 备选：直接使用本仓库 CLI

不经过官方包时，在 `repo/` 构建后：

```bash
cd repo
npm install
npm run build
npm run build:dashboard
npm link
maestro --version
maestro install
```

`npm link` 把本仓库链到全局 `maestro`。官方包与 link 不要混用。

---

## 卸载覆盖

覆盖没有单独回滚命令。恢复官方文件：

```bash
npm install -g maestro-flow@0.5.82
```

卸 Maestro 资产（保留 `.workflow/` 项目数据）：

```bash
maestro uninstall
```

卸 Grok CLI 按 xAI 官方说明处理。
