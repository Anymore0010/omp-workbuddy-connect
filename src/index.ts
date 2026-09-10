/**
 * omp-workbuddy-connect — bring WorkBuddy desktop models into omp with zero
 * configuration, reusing the WorkBuddy desktop app's own sign-in.
 *
 * The extension starts a loopback OpenAI-compatible shim and registers it as
 * the `workbuddy` provider with no apiKey/oauth. An extension provider with
 * only baseUrl+api+models is treated as keyless, so it is selectable without
 * any omp-side login or key — the WorkBuddy credential lives inside the
 * shim. Select models in /model as `workbuddy/<id>` (e.g. workbuddy/glm-5.3).
 *
 * For personal research/learning only: drives your own WorkBuddy account on
 * this machine. Not affiliated with Tencent / WorkBuddy.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent"
import { WorkBuddyUpstreamClient, normalizeCredits } from "./upstream"
import { WorkBuddyCredentialStore } from "./store"
import { WorkBuddyShim } from "./server"
import { FALLBACK_WORKBUDDY_MODELS } from "./catalog"
import type { WorkBuddyUpstreamModel } from "./upstream"

export const WORKBUDDY_PROVIDER = "workbuddy"

/**
 * Separator between a model's name and its billing suffix. A middle dot is
 * used because model names already contain hyphens (`GLM-5.3-Flash`), so a
 * hyphen would be ambiguous about where the name ends and the rate begins.
 */
const RATE_SEPARATOR = " · "

/**
 * Parse the credit multiplier from an upstream credits string (`x0.79` /
 * `x0.79 credits`) into a number. Missing/unparseable ⇒ 0, which omp's picker
 * renders as `free`.
 */
function multiplierOf(credits: string | undefined): number {
  const bare = normalizeCredits(credits)
  if (bare === undefined) return 0
  const matched = /^x?(\d*\.?\d+)$/u.exec(bare)
  return matched === null ? 0 : Number.parseFloat(matched[1]!)
}

/**
 * Map a raw upstream model to the omp provider model config shape.
 *
 * The credit multiplier and promo badges ride the *name*, which omp's
 * interactive picker renders on its selected-row detail line. The multiplier
 * additionally drives `cost.input` only (not `output`), so the picker's cost
 * column shows `$0.79/0` — a compact relative-rate indicator rather than a
 * blanket `free`; `x0.00` models and `auto` (no credits) resolve to zero and
 * keep the `free` label. Note omp's usage accounting treats `cost` as
 * per-million-token dollar prices, so WorkBuddy models will show nominal
 * "dollar" figures in session cost stats — these are relative indicators only,
 * because WorkBuddy bills in credits, not dollars.
 */
function toProviderModel(model: WorkBuddyUpstreamModel): ProviderModelConfig {
  const suffix = [
    normalizeCredits(model.billing.credits),
    ...(model.billing.badges ?? []),
  ].filter((part): part is string => part !== undefined && part !== "")
  const multiplier = multiplierOf(model.billing.credits)
  return {
    id: model.id,
    name: suffix.length === 0 ? model.name : `${model.name}${RATE_SEPARATOR}${suffix.join(RATE_SEPARATOR)}`,
    reasoning: model.reasoning.supports,
    input: model.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: multiplier, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }
}

export default async function workbuddyConnect(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("WorkBuddy Connect")

  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore(client)
  const shim = new WorkBuddyShim({
    store,
    client,
    fallbackModels: FALLBACK_WORKBUDDY_MODELS,
  })

  try {
    const port = await shim.listen()
    const baseUrl = `http://127.0.0.1:${port}/v1`
    pi.registerProvider(WORKBUDDY_PROVIDER, {
      baseUrl,
      api: "openai-completions",
      // The loopback shim owns the WorkBuddy credential (reused from the
      // desktop app) and ignores any inbound Authorization header, so this
      // literal apiKey is never validated — it only satisfies omp's runtime
      // requirement that a provider defining `models` carries apiKey or oauth
      // (extension registration has no `auth: none` escape hatch).
      apiKey: "workbuddy-desktop",
      models: FALLBACK_WORKBUDDY_MODELS.map(toProviderModel),
      // Runtime model discovery; omp bounds this to 15 s.
      fetchDynamicModels: async () => (await shim.dynamicModels()).map(toProviderModel),
    })
    pi.registerCommand("workbuddy-refresh", {
      description: "强制重新拉取 WorkBuddy 上游最新模型列表（绕过 omp 24h 动态发现缓存）",
      handler: async (_args, ctx) => {
        const credential = await store.current()
        if (credential === undefined) {
          ctx.ui.notify("WorkBuddy 未登录，无法刷新模型列表（先登录桌面版）", "error")
          return
        }
        const beforeIds = new Set(shim.currentModels().map(model => model.id))
        // Probe upstream directly so an offline failure is distinguishable from
        // "no change" (refreshProvider's internal fetch swallows errors, and
        // omp gates non-authoritative retries behind a 5-minute backoff).
        let fresh: readonly WorkBuddyUpstreamModel[]
        try {
          fresh = await client.fetchModels(credential)
        } catch {
          ctx.ui.notify(`WorkBuddy 上游不可达，已保留现有 ${beforeIds.size} 个模型`, "warning")
          return
        }
        if (fresh.length === 0) {
          ctx.ui.notify("WorkBuddy 上游返回空列表，已保留现有模型", "warning")
          return
        }
        try {
          // Strategy defaults to "online": unconditionally forces a live fetch.
          await ctx.modelRegistry.refreshProvider(WORKBUDDY_PROVIDER)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.ui.notify(`强刷失败：${message}（已保留现有模型）`, "error")
          return
        }
        // refreshProvider's fetch path updates the shim's in-memory catalog on a
        // non-empty upstream answer, so `currentModels()` now reflects the live list.
        const afterIds = new Set(shim.currentModels().map(model => model.id))
        const added = [...afterIds].filter(id => !beforeIds.has(id)).length
        ctx.ui.notify(
          added > 0
            ? `已强制刷新：共 ${afterIds.size} 个模型，本次新增 ${added} 个`
            : `已强制刷新：共 ${afterIds.size} 个模型，无新增`,
          "info",
        )
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    pi.logger.error("workbuddy-connect: shim failed to start", { error: message })
  }

  pi.on("session_shutdown", () => {
    shim.close()
  })
}