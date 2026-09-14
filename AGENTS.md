# AGENTS.md — omp-workbuddy-connect

把 WorkBuddy 桌面版模型接入 [omp](https://omp.sh/) 的扩展。本文件是本仓库的**发布与版本更新规范**，在任何一台电脑上操作都必须遵循同一流程，保证两台机器产出的版本一致。

## 仓库概览

- **远程仓库**：`https://github.com/luzov/omp-workbuddy-connect.git`
- **默认分支**：`main`
- **包名 / 版本**：`omp-workbuddy-connect`，版本号在 `package.json` 的 `version` 字段
- **运行时依赖**：无。扩展只用 Node 内置模块（`node:os/path/fs/http`）；`@oh-my-pi/pi-coding-agent` 仅作**类型**导入（运行时被擦除）。因此**分发物不需要 `node_modules`**。
- **目录结构**：
  - `src/index.ts` — 扩展入口，`pi.registerProvider("workbuddy", …)` + `/workbuddy-refresh` 命令
  - `src/upstream.ts` — WorkBuddy 上游 wire 客户端（chat / models / refresh、请求头、body 归一化）
  - `src/auth.ts` — 桌面 auth 文件探测（Win/mac/Linux/WSL）、解析
  - `src/store.ts` — 凭证按需刷新
  - `src/server.ts` — loopback OpenAI 兼容 shim + SSE 归一化
  - `src/catalog.ts` — 静态兜底模型表
- **发布物**：每个版本一个 GitHub Release，附 `omp-workbuddy-connect-portable.zip` 附件。

## 环境前提

- **Node.js 18+**（用于 typecheck 与打包；本项目在 Node 24 验证）
- **Git**（2.30+；`git archive` 用于打包）
- typecheck 需要先装开发依赖：`npm install`（只装 `@oh-my-pi/pi-coding-agent`、`typescript`、`@types/node`）
- 上传 Release 需要 GitHub 凭据，二选一：
  - **推荐 `gh` CLI**：`gh auth login` 后可直接用 `gh release create/upload`
  - **无 `gh` 时**：环境变量 `GH_TOKEN`（或 `GITHUB_TOKEN`），scope 至少 `public_repo`；用 `curl` 调 GitHub API

## 版本更新流程（两台机器一致）

> ⚠️ 核心原则：**版本号、tag、Release、附件四者必须对应同一个 commit**。tag 一旦推送不要移动；出错就发新补丁版本（如 `v0.1.1` → `v0.1.2`）。

### 1. 同步与改代码

```bash
git pull --ff-only origin main      # 先同步，避免分叉
# …修改 src/ 或 README.md…
```

### 2. 本地验证（必须通过才继续）

```bash
npm install                                                  # 首次或依赖变更后
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

`tsc` 必须以 exit 0 结束。扩展本身可在本机实测加载：

```bash
omp models -e D:/Projects/omp-workbuddy-connect        # 应列出 workbuddy (N)
# 或已 link 的情况下（仓库根目录）：
cd /d/Projects/omp-workbuddy-connect && omp plugin link . && omp models | grep workbuddy
```

端到端调用（需本机 WorkBuddy 桌面版已登录）：

```bash
omp --model workbuddy/glm-5.3 -p "只回答：OK"
```

### 3. 升版本号

只改 `package.json` 的 `version`（语义化版本）：

```bash
# 例：0.1.1 → 0.1.2
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.version='0.1.2';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
```

### 4. 提交并推送

```bash
git add -A
git commit -m "feat: <一句话说明>（v0.1.2）"
git push origin main
```

提交信息约定：`feat:` / `fix:` / `docs:` / `chore:` 前缀 + 一句话说明。

### 5. 打 tag 并推送

```bash
git tag -a v0.1.2 -m "v0.1.2"
git push origin v0.1.2
```

### 6. 生成 portable zip（只用 git，跨平台一致）

**不要手工挑选文件**——用 `git archive` 从当前 commit 导出，保证与 tag 内容完全一致，也自动排除 `node_modules`、`*.mts` 等未跟踪/已忽略文件：

```bash
# 在仓库根目录执行
git archive --format=zip -o ../omp-workbuddy-connect-portable.zip --prefix=omp-workbuddy-connect/ HEAD
```

产物：`../omp-workbuddy-connect-portable.zip`，解压后顶层目录为 `omp-workbuddy-connect/`。

### 7. 创建 Release 并上传附件

**方式 A（推荐，需 `gh` CLI）**：

```bash
gh release create v0.1.2 ../omp-workbuddy-connect-portable.zip \
  --title "v0.1.2 — <标题>" \
  --notes "<变更说明>"
```

**方式 B（无 `gh`，用 `GH_TOKEN` + curl）**：

```bash
# 创建 release（拿到 id）
RID=$(curl -s -X POST \
  -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/luzov/omp-workbuddy-connect/releases \
  -d '{"tag_name":"v0.1.2","name":"v0.1.2 — <标题>","body":"<变更说明>"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")

# 上传 zip 附件
curl -s -X POST \
  -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/zip" \
  --data-binary @../omp-workbuddy-connect-portable.zip \
  "https://uploads.github.com/repos/luzov/omp-workbuddy-connect/releases/$RID/assets?name=omp-workbuddy-connect-portable.zip"
```

**方式 C（无凭据）**：在 GitHub 网页 Releases 页手动 Draft/发布 Release，并拖入 zip。

### 8. 核验（发布后必做）

```bash
# 确认本地与远程同步
git status -sb                     # 应为 ## main...origin/main（无 ahead/behind）

# 确认 release 有附件（方式 B 时）
curl -s -H "Authorization: Bearer $GH_TOKEN" \
  https://api.github.com/repos/luzov/omp-workbuddy-connect/releases/tags/v0.1.2 \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.name);r.assets.forEach(a=>console.log(' asset:',a.name,a.size))})"
```

**验收标准**：`tag` 存在、Release 存在、附件 1 个且小于 ~50 KB、`git status -sb` 无 ahead/behind。

## 常见坑

- **忘记重新打包就上传**：`v0.1.1` 曾出现 release 无附件。上传前务必先跑第 6 步，且**先 `git push` 再打包**（`git archive HEAD` 取的是本地 commit）。
- **`git archive` 的 `-o` 用相对路径**：Windows 上 git 不认 MSYS 风格 `/d/Projects/...` 绝对路径，用 `../name.zip` 这类相对路径。
- **CRLF 警告**：Windows 下 `git add` 会提示 `LF will be replaced by CRLF`，属正常，不要提交 `.gitattributes` 强制改行尾，否则会污染 diff。
- **`node_modules` 绝不入库**：`.gitignore` 已排除。若 `git status` 出现 `node_modules/`，说明 `.gitignore` 被改坏。
- **不要提交凭证**：`~/.omp/.workbuddy-auth.json` 与 WorkBuddy 桌面的 `workbuddy-desktop.info` 含真实 token，不在仓库目录内；切勿复制进仓库。上传前可扫一遍：
  ```bash
  grep -rniE "eyJ[A-Za-z0-9_-]{10,}|accessToken.*\"[A-Za-z0-9]{20}" src/ README.md package.json
  ```
- **不要移动已推送的 tag**：`git push --force` tag 会导致别人下载到不一致内容；要改就发新版本。
- **`.mts` 冒烟脚本**：`smoke*.mts` 属本地调试文件，已被 `.gitignore` 的 `*.mts` 排除，不要提交。

## 硬编码常量（升级 WorkBuddy 后需要复核）

- `src/upstream.ts` 中的 `DESKTOP_CLIENT_VERSION = "5.5.4"`（chat 的 `X-IDE-Version` 与桌面 UA 的 `WorkBuddy/<v>` 段）—— 若 WorkBuddy 桌面版升级，此值会过时（不影响功能，仅影响用量页版本显示），可随版本更新一并调整。
- `src/upstream.ts` 中的 `DESKTOP_CLI_VERSION = "2.137.1"`（桌面 UA 的 `CLI/<v>` 段）—— 对齐官方内置 CLI 版本，接口行为变化时同步。
- `src/upstream.ts` 中的 `CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2"` —— refresh/catalog 路径的 User-Agent（chat 用桌面 UA），若接口行为变化需同步。
- `src/catalog.ts` 的兜底模型表 —— 上游在线时会被 `fetchDynamicModels` 覆盖；仅在离线/首次启动时使用，可选更新。

## 安装与分发（写进用户文档的用法）

```bash
# Git 直装
omp install github:luzov/omp-workbuddy-connect

# 或下载 Release 的 portable zip，解压后
omp plugin link .
```

前提：本机已安装并登录 WorkBuddy 桌面版。无需 npm install，无需 omp 侧 API Key。

## 合规声明（发布物必须保留）

本项目**非官方**，仅供个人学习研究；驱动的是 WorkBuddy 客户端接口（非公开 API），协议可能随时变化；与腾讯 / WorkBuddy / CodeBuddy 无关联。README 的 `## Disclaimer`、`## Reference projects` 与 `LICENSE` 发布时不得删除。
