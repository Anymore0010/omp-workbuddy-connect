/**
 * Static fallback catalog of WorkBuddy CLI models (the `cli` agent's roster,
 * observed on the CN endpoint). Replaced by the upstream's live answer once it
 * loads, so models are selectable even while discovery is still in flight or
 * the upstream is offline. Billing multipliers and promo badges mirror the
 * live catalog so the display suffix stays accurate before discovery lands.
 */

import type { WorkBuddyUpstreamModel } from "./upstream"

const BADGE_PROMO = "限时免费"
const BADGE_EXCLUSIVE = "独家优惠"
const BADGE_NIGHT = "夜间折扣"

function model(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  billing: WorkBuddyUpstreamModel["billing"],
  supportsImages = true,
  supportedEfforts?: string[],
): WorkBuddyUpstreamModel {
  return {
    id,
    name,
    contextWindow,
    maxTokens,
    supportsImages,
    reasoning: {
      supports: true,
      onlyReasoning: true,
      canDisableThinking: false,
      ...(supportedEfforts !== undefined ? { supportedEfforts } : {}),
    },
    billing,
  }
}

export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyUpstreamModel[] = [
  model("auto", "Auto", 168_000, 32_000, { free: false }),
  model("hy3", "Hy3", 192_000, 64_000, { credits: "x0.00", badges: [BADGE_PROMO], free: true }),
  model("hy4-preview", "Hy4 preview", 1_000_000, 64_000, { credits: "x0.00", badges: [BADGE_PROMO], free: true }),
  model("hy3-x", "Hy3", 192_000, 64_000, { credits: "x0.05", free: false }, true, ["low", "high"]),
  model("deepseek-v4.1-flash", "Deepseek-V4.1-Flash", 1_000_000, 50_000, { credits: "x0.03", badges: [BADGE_EXCLUSIVE], free: false }),
  model("glm-5.3", "GLM-5.3", 1_000_000, 48_000, { credits: "x0.79", free: false }, true, ["low", "high", "xhigh"]),
  model("glm-5.3-flash", "GLM-5.3-Flash", 1_000_000, 32_000, { credits: "x0.06", free: false }, true, ["low", "high", "max"]),
  model("glm-5.2", "GLM-5.2", 1_000_000, 48_000, { credits: "x0.79", badges: [BADGE_NIGHT], free: false }),
  model("glm-5.1", "GLM-5.1", 200_000, 48_000, { credits: "x0.79", free: false }, false),
  model("glm-5v-turbo", "GLM-5v-Turbo", 200_000, 64_000, { credits: "x0.71", free: false }),
  model("kimi-k3-1", "Kimi-K3", 1_000_000, 32_000, { credits: "x1.62", free: false }),
  model("kimi-k2.7", "Kimi-K2.7-Code", 256_000, 32_000, { credits: "x0.57", free: false }),
  model("kimi-k2.6", "Kimi-K2.6", 256_000, 32_000, { credits: "x0.52", free: false }),
  model("minimax-m3", "MiniMax-M3", 512_000, 128_000, { credits: "x0.25", free: false }),
  model("deepseek-v4-pro", "Deepseek-V4-Pro", 1_000_000, 50_000, { credits: "x0.51", free: false }),
]