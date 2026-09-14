# omp-workbuddy-connect

把 **WorkBuddy 桌面版的模型**接入 [omp](https://omp.sh/)，**零配置** —— 插件直接复用 WorkBuddy 应用自身的登录态，你无需在 omp 里再登录一次。

WorkBuddy CLI 提供的模型（`auto`、`hy4-preview`、`hy3`、`glm-5.3`、`glm-5.3-flash`、`glm-5.2`、`kimi-k3-1`、`kimi-k2.7`、`minimax-m3`、`deepseek-v4-pro`、……）可在 omp 的 `/model` 选择器中直接以 `workbuddy/<id>` 形式选用。

> ⚠️ 仅供个人研究/学习用途 —— 驱动的是**你自己的** WorkBuddy 账号，仅在本机运行。与腾讯 / WorkBuddy 无任何关联；请遵守 WorkBuddy 服务条款。

## 工作原理

WorkBuddy 桌面端上游（`copilot.tencent.com` / `workbuddy.ai`）**不是** OpenAI 兼容的线协议：它需要特定的请求头（`X-User-Id`、`X-Product`、`X-Domain`、……），强制 `stream: true`，拒绝 `role: "developer"`，要求 `tool_choice` 为字符串，有自己的 effort 分级，并且流式返回 `reasoning_content` 及大量噪声字段。它还用桌面应用自身的令牌鉴权，而非 API 密钥。

因此本扩展做了 [dsh-workbuddy-connect](https://dsh.pub/en/plugins/dsh-workbuddy-connect/) 为 DeepSeek Harness 所做的事，移植到 omp：

1. **Loopback shim** —— 加载时在本机启动一个绑定 `127.0.0.1:<随机端口>` 的 HTTP 服务，暴露标准 OpenAI 格式的 `/v1/chat/completions` 与 `/v1/models`。
2. **凭据复用** —— 读取 WorkBuddy 桌面应用的鉴权文件（Windows 在 AppData、macOS 在 Application Support、Linux 在 `~/.config` 下的 `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`），并在令牌临近过期时刷新，副本保存在 omp 主目录（`~/.omp/.workbuddy-auth.json`）。插件绝不回写桌面端文件。
3. **协议转换** —— `/v1/chat/completions` 把传入的 OpenAI 请求规范化成 WorkBuddy 所需格式（强制 stream、`developer`→`system`、字符串 `tool_choice`、reasoning-effort 降级），用正确的请求头调用上游，并把返回的 SSE 流重建回 OpenAI 白名单（保留 `reasoning_content`、剥离噪声、恰好一个 `[DONE]`）。非流式请求则聚合成一次完整响应。
4. **Provider 注册** —— 通过 `pi.registerProvider(...)` 把 `workbuddy` provider 指向 loopback，附带静态兜底目录 + `fetchDynamicModels` 做实时发现。由于令牌归 shim 管理，该 provider 以无密钥方式注册 —— 无需在 omp 登录或配置 API 密钥。
5. **强制刷新** —— 提供 `/workbuddy-refresh` 命令，调用 `ctx.modelRegistry.refreshProvider(...)`（默认 `online` 策略）绕过 omp 对 `fetchDynamicModels` 的 24 小时缓存，随时强制拉取上游最新模型列表。

扩展进程内运行、**不沙箱化**，且只接受 loopback 来源的请求（拒绝非 loopback 的 `Host` 头，防止 DNS rebinding 攻击）。

## 手动刷新模型列表

omp 对 `fetchDynamicModels` 的动态列表有 **24 小时缓存**：正常打开 omp 时，只要上次拉取在 24h 内，就会直接复用缓存、不请求上游——所以新模型不会每次都实时出现。

插件提供 **`/workbuddy-refresh`** 命令强制绕过该缓存，手动拉取上游最新列表：

```
/workbuddy-refresh
```

行为：

- 先探活上游。若未登录桌面版、或上游不可达、或返回空列表，会提示对应原因并**保留现有列表**，不会清空。
- 成功则调用 `ctx.modelRegistry.refreshProvider("workbuddy")`（默认 `online` 策略，不受 24h 缓存门控）强制联网刷新。
- 完成后弹出提示，例如 `已强制刷新：共 N 个模型，本次新增 X 个`（无新增则提示「无新增」）。

刷新后到 `/model` 里即可看到 `workbuddy/*` 的最新可选模型。

## 依赖环境

- Windows / macOS / Linux（支持 WSL），且**已安装并登录** WorkBuddy 桌面应用。
- omp 17.4.0 或更新版本（需支持扩展 `registerProvider`）。本仓库针对内置的 `@oh-my-pi/pi-coding-agent` 类型锁定版本。

## 安装

在终端中，指向本目录执行：

```bash
cd /path/to/omp-workbuddy-connect
omp plugin link .
```

本地链接会以符号链接形式加入 `~/.omp/plugins`，因此你在此处的修改会在下次启动 omp 时生效。确认已加载：

```bash
omp plugin list
omp plugin doctor omp-workbuddy-connect   # 观察是否出现 "plugin: ... ok"
```

启动新的 omp 会话（`omp`），打开 `/model`，选择 `workbuddy/glm-5.3` 或任意 WorkBuddy 模型。

> 注：在 Windows 上若 `omp plugin link` 因符号链接权限（EPERM）失败（未开启「开发人员模式」或以非管理员身份运行），可改用下方方式：把绝对路径写进 `~/.omp/agent/config.yml`：
>
> ```yaml
> extensions:
>   - /path/to/omp-workbuddy-connect
> ```

## 开发

本包为纯 TypeScript，无运行时依赖（仅用 Node 内置模块）；`@oh-my-pi/pi-coding-agent` 仅作 dev 依赖提供类型。

```bash
npm install                                  # 安装 dev 类型依赖
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json   # 类型检查
```

omp 加载的入口是 `src/index.ts`。其余模块：

- `src/auth.ts` — 桌面端鉴权文件的发现、解析、自有副本持久化
- `src/upstream.ts` — WorkBuddy 上游 wire 客户端（chat / models / refresh）
- `src/store.ts` — 凭据存储 + 按需刷新
- `src/server.ts` — loopback OpenAI 兼容 shim + SSE 归一化
- `src/catalog.ts` — 静态兜底模型目录

## 关于聊天记录

通过本插件发出的对话**会像桌面端一样被 WorkBuddy 服务端记录**，这**不是插件行为**，无法从插件侧关闭：

- 插件唯一的落盘是 `~/.omp/.workbuddy-auth.json`（复制复用桌面端登录态），**不写入任何聊天内容**。
- 记录发生在**服务端，按账号归档**（`X-User-Id` + bearer token）。插件以你的桌面端身份发起请求，因此落在同一个云端会话/用量历史里。
- 已核查过 WorkBuddy 桌面客户端包（`app.asar`）：其中**不存在**"不记录/临时会话"类开关或字段（`noMemory`、`temporary`、`store:false` 等一律无命中），请求体也只由 `messages/model/stream/stream_options/tool_choice/reasoning_effort` 构成，没有可供镜像的持久化开关。
- 结论：这是**上游账号属性**，不是可配置项。介意记录的话，唯一可控手段是**改用不共享该账号的渠道**。

## 免责声明

- 本项目**仅供个人学习与研究使用**。它驱动的是**你自己**机器上**你自己的** WorkBuddy 账号，不适用于任何商业用途或超出个人合理使用范围的情形。
- 它依赖的是 WorkBuddy **客户端**端点（并非官方公开 API）。WorkBuddy 随时可能更改其协议，届时本插件可能需要跟进适配。通过第三方客户端使用你的账号，须遵守 WorkBuddy 服务条款；由此产生的一切后果（包括但不限于账号限制、额度扣除、服务中断）由你自行承担。
- 本项目与 腾讯、WorkBuddy、CodeBuddy、DeepSeek **无关联、未经授权、亦未获其背书**。产品名称仅用于描述兼容性；其商标归各自所有者所有。
- 作者对因使用或误用本项目造成的任何直接或间接损失不承担任何责任。

## 参考项目

本项目依据以下项目所记录的 WorkBuddy 线协议编写。它是**干净的重新实现** —— 未复制任何源代码；仅参考了协议事实（端点路径、请求头名称、字段语义）。

| 项目 | 许可证 | 作用 |
| --- | --- | --- |
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | MIT（© Corrine Hu） | 确立 loopback-shim 方案与只读复用 WorkBuddy 桌面鉴权文件的 DeepSeek Harness 插件。其 `upstream.ts` / `auth.ts` / `shim.ts` 定义了本移植所遵循的线行为。 |
| [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) | *(仓库中无 LICENSE 文件)* | 用作 chat / 令牌刷新 / 模型目录端点及其请求头的协议参考的 Go OpenAI 兼容网关。未复制代码，也不声称其许可证。 |

两者都驱动 WorkBuddy 客户端端点，其并非官方公开 API；详见上方免责声明。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。