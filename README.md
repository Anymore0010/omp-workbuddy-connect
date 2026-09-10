# omp-workbuddy-connect

Bring the **WorkBuddy desktop app's models** into [omp](https://omp.sh/) with zero configuration — the plugin reuses the WorkBuddy app's own sign-in, so there is nothing to log in to inside omp.

Models offered by the WorkBuddy CLI (`auto`, `hy4-preview`, `hy3`, `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `kimi-k3-1`, `kimi-k2.7`, `minimax-m3`, `deepseek-v4-pro`, …) become selectable directly in omp's `/model` picker as `workbuddy/<id>`.

> ⚠️ For personal research/learning only — drives **your own** WorkBuddy account on this machine. Not affiliated with Tencent / WorkBuddy; respects the WorkBuddy terms of service.

## How it works

The WorkBuddy desktop upstream (`copilot.tencent.com` / `workbuddy.ai`) is **not** an OpenAI-compatible wire: it needs specific request headers (`X-User-Id`, `X-Product`, `X-Domain`, …), forces `stream: true`, rejects `role: "developer"`, wants `tool_choice` as a string, has its own effort ladder, and streams `reasoning_content` plus noise fields. It also authenticates with the desktop app's tokens, which is not an API key.

So this extension does what [dsh-workbuddy-connect](https://dsh.pub/en/plugins/dsh-workbuddy-connect/) does for DeepSeek Harness, ported to omp:

1. **Loopback shim** — on load it starts a local HTTP server bound to `127.0.0.1:<ephemeral>` exposing `/v1/chat/completions` and `/v1/models` in standard OpenAI format.
2. **Credential reuse** — reads the WorkBuddy desktop app's auth file (`CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` under AppData on Windows / Application Support on macOS / `~/.config` on Linux), and refreshes the token near expiry, keeping a copy under the omp home (`~/.omp/.workbuddy-auth.json`). The desktop file is never written by the plugin.
3. **Translation** — `/v1/chat/completions` normalizes the incoming OpenAI body for WorkBuddy (force stream, `developer`→`system`, string `tool_choice`, reasoning-effort downgrade), calls the upstream with the correct headers, and streams the SSE back rebuilt to the OpenAI whitelist (`reasoning_content` preserved, noise stripped, exactly one `[DONE]`). Non-streaming requests are aggregated to a single completion.
4. **Provider registration** — registers the `workbuddy` provider via `pi.registerProvider(...)` pointing at the loopback, with the static fallback catalog plus `fetchDynamicModels` for live discovery. Since the shim owns the credential, the provider is registered keyless — no omp login or API key required.

The extension runs in-process, is **not sandboxed**, and only ever accepts loopback-originated requests (rejects non-loopback `Host` headers to prevent DNS-rebinding attacks).

## Requirements

- Windows / macOS / Linux (WSL supported) with the **WorkBuddy desktop app installed and signed in**.
- omp 17.4.0 or newer (extension `registerProvider` support). This repo is pinned against the bundled `@oh-my-pi/pi-coding-agent` types.

## Install

From a terminal, pointing at this directory:

```bash
cd /path/to/omp-workbuddy-connect
omp plugin link .
```

A local link is a symlink into `~/.omp/plugins`, so edits you make here are picked up the next time omp starts. Confirm it loaded:

```bash
omp plugin list
omp plugin doctor omp-workbuddy-connect   # watch for "plugin: ... ok"
```

Start a fresh omp session (`omp`), open `/model`, and pick `workbuddy/glm-5.3` or any other WorkBuddy model.

Alternative, without linking — add the absolute path to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - /path/to/omp-workbuddy-connect
```

## Development

The package is plain TypeScript with no runtime dependencies (Node builtins
only); `@oh-my-pi/pi-coding-agent` is a dev-only dependency for types.

```bash
npm install                                  # install the dev type deps
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json   # typecheck
```

The entry that omp loads is `src/index.ts`. The rest is:

- `src/auth.ts` — desktop auth-file discovery, parsing, owned-copy persistence
- `src/upstream.ts` — WorkBuddy upstream wire client (chat / models / refresh)
- `src/store.ts` — credential store with demand-driven refresh
- `src/server.ts` — loopback OpenAI-compatible shim + SSE normalization
- `src/catalog.ts` — static fallback model catalog

## Disclaimer

- This project is for **personal learning and research use only**. It drives
  **your own** WorkBuddy account on your own machine and is not intended for
  commercial use or any scenario beyond personal fair use.
- It relies on the WorkBuddy **client** endpoints (not an official public API).
  WorkBuddy may change its protocol at any time, and this plugin may need to
  follow. Use of your account through a third-party client is subject to
  WorkBuddy's terms of service; you are responsible for any consequence,
  including but not limited to account restriction, credit loss, or service
  interruption.
- This project is **not affiliated with, authorized by, or endorsed by**
  Tencent, WorkBuddy, CodeBuddy, or DeepSeek. Product names are used only to
  describe compatibility; their trademarks belong to their respective owners.
- The authors accept no liability for any direct or indirect loss arising from
  the use or misuse of this project.

## Reference projects

This project was written against the WorkBuddy wire protocol as documented by
the following projects. It is a **clean reimplementation** — no source code was
copied; only the protocol facts (endpoint paths, request-header names, field
semantics) were referenced.

| Project | License | Role |
| --- | --- | --- |
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | MIT (© Corrine Hu) | The DeepSeek Harness plugin that established the loopback-shim approach and the read-only reuse of the WorkBuddy desktop auth file. Its `upstream.ts` / `auth.ts` / `shim.ts` defined the wire behaviour this port follows. |
| [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) | *(no LICENSE file in the repository)* | A Go OpenAI-compatible gateway used as a protocol reference for the chat / token-refresh / model-catalog endpoints and their request headers. No code copied, and no license is claimed from it. |

Both drive the WorkBuddy client endpoints, which are **not** an official public
API; see the disclaimer above.

## License

MIT — see [LICENSE](./LICENSE).