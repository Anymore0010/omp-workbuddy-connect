/**
 * WorkBuddy upstream wire client: chat streaming, model catalog, and token
 * refresh. These endpoints are the CodeBuddy CLI/plugin interfaces (not an
 * official public API), as documented by dsh-workbuddy-connect and the
 * workbuddy2api reference.
 */

import type { WorkBuddyCredential } from "./auth"

export type WorkBuddyUpstreamModel = {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
  reasoning: {
    supports: boolean
    onlyReasoning: boolean
    canDisableThinking: boolean
    supportedEfforts?: string[]
  }
  /** Billing metadata the catalog reports: credit multiplier and promo badges. */
  billing: {
    credits?: string
    badges?: string[]
    free: boolean
  }
}

const CN_CHAT_BASE = "https://copilot.tencent.com"
const CN_BILLING_BASE = "https://www.codebuddy.cn"
const GLOBAL_BASE = "https://www.workbuddy.ai"

const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2"
const ERROR_BODY_LIMIT = 4096

const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"])
const EFFORT_RANK: Record<string, number> = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }

function regionOf(domain: string): "cn" | "global" {
  const lowered = domain.trim().toLowerCase()
  return lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai") ? "global" : "cn"
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE
}

function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const origin = originReferer(credential)
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": CLIENT_UA,
  }
}

export function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    "Content-Type": "application/json",
    // 安全红线：chat 请求绝不携带 refresh token。
    ...(credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ""
      ? { "X-No-Enterprise-Id": "1" }
      : { "X-Enterprise-Id": credential.enterpriseId }),
    ...(credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain }),
    "X-Product": "SaaS",
    // Client identification. The billing usage page records a per-request
    // client label from X-IDE-Name; requests without it are logged with a
    // blank client. `WorkBuddy` is the desktop client spelling.
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "CodeBuddy",
    "X-IDE-Version": "5.5.4",
  }
  return headers
}

function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    "X-Refresh-Token": credential.refreshToken,
    "X-Auth-Refresh-Source": "workbuddy",
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = credential.enterpriseId
  }
  return headers
}

function normalizeDeveloperRole(obj: Record<string, unknown>): void {
  const messages = obj.messages
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (message !== null && typeof message === "object") {
      const wrapped = message as Record<string, unknown>
      if (wrapped.role === "developer") wrapped.role = "system"
    }
  }
}

function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj.tools
    delete obj.functions
  }
  if (!("tool_choice" in obj)) return
  const choice: unknown = obj.tool_choice
  if (typeof choice === "string") {
    if (choice.trim().toLowerCase() === "none") {
      delete obj.tool_choice
      suppress()
    }
    return
  }
  if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped.type === "string" ? wrapped.type.trim().toLowerCase() : ""
    if (type === "none") {
      delete obj.tool_choice
      suppress()
    } else if (type === "auto" || type === "required") {
      obj.tool_choice = type
    } else if (type === "function") {
      const fn = wrapped.function
      const fnName = fn !== null && typeof fn === "object"
        ? (fn as Record<string, unknown>).name
        : undefined
      let name = typeof fnName === "string" ? fnName : ""
      if (name === "" && typeof wrapped.name === "string") name = wrapped.name
      name = name.trim()
      obj.tool_choice = name !== "" ? name : "auto"
    } else {
      delete obj.tool_choice
    }
    return
  }
  delete obj.tool_choice
}

function normalizeReasoningEffort(obj: Record<string, unknown>, efforts: Map<string, string[]>): void {
  if (efforts.size === 0) return
  const model = obj.model
  if (typeof model !== "string") return
  const supported = efforts.get(model)
  if (supported === undefined || supported.length === 0) return
  let key = ""
  if ("reasoning_effort" in obj) key = "reasoning_effort"
  else if ("reasoningEffort" in obj) key = "reasoningEffort"
  else return
  const req = obj[key]
  if (typeof req !== "string") return
  const reqRank = EFFORT_RANK[req.trim().toLowerCase()]
  if (reqRank === undefined) return
  // Highest supported effort <= the requested one; if all are above, take lowest.
  let best = ""
  let bestRank = -1
  for (const s of supported) {
    const rank = EFFORT_RANK[s.trim().toLowerCase()]
    if (rank !== undefined && rank <= reqRank && rank > bestRank) {
      best = s
      bestRank = rank
    }
  }
  if (best !== "") {
    obj[key] = best
    return
  }
  let lowest = ""
  let lowestRank = Number.MAX_SAFE_INTEGER
  for (const s of supported) {
    const rank = EFFORT_RANK[s.trim().toLowerCase()]
    if (rank !== undefined && rank < lowestRank) {
      lowest = s
      lowestRank = rank
    }
  }
  if (lowest !== "") obj[key] = lowest
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true`, flatten `tool_choice`, rewrite `developer` roles, and
 * downgrade `reasoning_effort` to the model's supported ladder.
 */
export function prepareChatBody(source: string, efforts: Map<string, string[]>): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj.stream = true
  normalizeDeveloperRole(obj)
  normalizeToolChoice(obj)
  normalizeReasoningEffort(obj, efforts)
  return JSON.stringify(obj)
}

/**
 * Reduce an upstream credits string to its language-neutral display form.
 * Rows report either a bare multiplier (`x0.79`) or one with a unit word
 * (`x0.79 credits`); dropping the trailing unit yields the spelling that
 * reads identically in every language.
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined
  const trimmed = credits.trim()
  if (trimmed === "") return undefined
  if (/^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, "").trim()
  return bare === "" ? undefined : bare
}

/** Parse the upstream `credits` / `tags` fields into billing metadata. */
function resolveBilling(model: Record<string, unknown>): WorkBuddyUpstreamModel["billing"] {
  const rawCredits = model.credits
  const credits = typeof rawCredits === "string" && rawCredits.trim() !== "" ? rawCredits.trim() : undefined
  const badges: string[] = []
  const rawTags = model.tags
  if (Array.isArray(rawTags)) {
    for (const tag of rawTags) {
      if (typeof tag !== "string") continue
      if (!tag.toLowerCase().startsWith("badge:")) continue
      const label = tag.slice("badge:".length).split(":")[0]
      if (label !== undefined && label !== "") badges.push(label)
    }
  }
  // A `x0.00` multiplier means the model is currently free.
  const free = credits !== undefined && /^x?0\.0+$/iu.test(credits)
  return {
    ...(credits !== undefined ? { credits } : {}),
    ...(badges.length > 0 ? { badges } : {}),
    free,
  }
}

function resolveReasoning(model: Record<string, unknown>): WorkBuddyUpstreamModel["reasoning"] {
  const raw = model.reasoning
  if (raw === null || typeof raw !== "object") {
    return { supports: false, onlyReasoning: false, canDisableThinking: false }
  }
  const reasoning = raw as Record<string, unknown>
  const supportedEffortsRaw = reasoning.supportedEfforts
  const defaultEffortRaw = reasoning.defaultEffort
  const defaultEffort = typeof defaultEffortRaw === "string" && EFFORT_VALUES.has(defaultEffortRaw)
    ? defaultEffortRaw
    : typeof reasoning.effort === "string" && EFFORT_VALUES.has(reasoning.effort as string)
      ? reasoning.effort as string
      : undefined
  const result: WorkBuddyUpstreamModel["reasoning"] = {
    supports: reasoning.supports === true,
    onlyReasoning: reasoning.onlyReasoning === true,
    canDisableThinking: reasoning.canDisableThinking === true,
  }
  if (Array.isArray(supportedEffortsRaw)) {
    result.supportedEfforts = supportedEffortsRaw.filter((v): v is string => typeof v === "string")
  }
  if (defaultEffort !== undefined) {
    ;(result as Record<string, unknown>).defaultEffort = defaultEffort
  }
  return result
}

export class WorkBuddyUpstreamClient {
  private efforts: Map<string, string[]> = new Map()

  /** POST the chat endpoint; a candidate result is the raw SSE Response. */
  async chatStream(credential: WorkBuddyCredential, bodyJson: string): Promise<Response> {
    return fetch(`${chatBase(credential)}/v2/chat/completions`, {
      method: "POST",
      headers: { ...chatHeaders(credential), Authorization: `Bearer ${credential.accessToken}` },
      body: prepareChatBody(bodyJson, this.efforts),
    })
  }

  /** POST the token-refresh endpoint. */
  async refreshToken(credential: WorkBuddyCredential): Promise<{
    accessToken: string
    refreshToken?: string
    expiresInSec?: number
    domain?: string
  }> {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: "POST",
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(30_000),
    })
    const envelope = await this.readEnvelope(response)
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`workbuddy token refresh failed (http ${response.status}): ${envelope.msg.slice(0, 160)}`)
    }
    const data = envelope.data === null || typeof envelope.data !== "object"
      ? {}
      : envelope.data as Record<string, unknown>
    const accessToken = data.accessToken
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app")
    }
    const result: { accessToken: string; refreshToken?: string; expiresInSec?: number; domain?: string } = { accessToken }
    if (typeof data.refreshToken === "string" && data.refreshToken !== "") result.refreshToken = data.refreshToken
    if (typeof data.expiresIn === "number" && data.expiresIn > 0) result.expiresInSec = data.expiresIn
    if (typeof data.domain === "string" && data.domain !== "") result.domain = data.domain
    return result
  }

  /** GET the personal model catalog and keep the `cli` agent's models only. */
  async fetchModels(credential: WorkBuddyCredential): Promise<WorkBuddyUpstreamModel[]> {
    const response = await fetch(`${chatBase(credential)}/console/enterprises/personal/models`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
        Origin: originReferer(credential),
        Referer: `${originReferer(credential)}/`,
        "User-Agent": CLIENT_UA,
      },
      signal: AbortSignal.timeout(30_000),
    })
    const envelope = await this.readEnvelope(response)
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`workbuddy models failed (http ${response.status}): ${envelope.msg.slice(0, 160)}`)
    }
    const data = envelope.data === null || typeof envelope.data !== "object"
      ? {}
      : envelope.data as Record<string, unknown>
    const rawModels = Array.isArray(data.models) ? data.models : []
    const agents = Array.isArray(data.agents) ? data.agents : []
    let cliIds: string[] | undefined
    for (const agent of agents) {
      if (agent !== null && typeof agent === "object") {
        const wrapped = agent as Record<string, unknown>
        if (wrapped.name === "cli" && Array.isArray(wrapped.models)) {
          cliIds = wrapped.models.filter((id): id is string => typeof id === "string")
          break
        }
      }
    }
    if (cliIds === undefined || cliIds.length === 0) {
      throw new Error("workbuddy model catalog lists no cli agent models")
    }
    const byId = new Map<string, WorkBuddyUpstreamModel>()
    for (const model of rawModels) {
      if (model === null || typeof model !== "object") continue
      const wrapped = model as Record<string, unknown>
      const id = typeof wrapped.id === "string" ? wrapped.id : ""
      if (id === "" || wrapped.disabled === true) continue
      const input = wrapped.maxInputTokens
      const output = wrapped.maxOutputTokens
      if (typeof input !== "number" || typeof output !== "number" || input <= 0 || output <= 0) continue
      const name = typeof wrapped.name === "string" && wrapped.name !== "" ? wrapped.name : id
      byId.set(id, {
        id,
        name,
        contextWindow: input,
        maxTokens: output,
        supportsImages: wrapped.supportsImages === true && wrapped.disabledMultimodal !== true,
        reasoning: resolveReasoning(wrapped),
        billing: resolveBilling(wrapped),
      })
    }
    const models = cliIds.flatMap((id) => {
      const m = byId.get(id)
      return m === undefined ? [] : [m]
    })
    if (models.length === 0) {
      throw new Error("workbuddy model catalog resolved to an empty list")
    }
    // Refresh the effort cache used for reasoning downgrade on chat bodies.
    const next: Map<string, string[]> = new Map()
    for (const m of models) {
      if (m.reasoning.supportedEfforts !== undefined && m.reasoning.supportedEfforts.length > 0) {
        next.set(m.id, m.reasoning.supportedEfforts)
      }
    }
    this.efforts = next
    return models
  }

  /** GET the billing endpoint for the aggregated remaining credit. */
  async fetchCredits(credential: WorkBuddyCredential): Promise<{ total: number; accounts: { packageName: string; remain: number; size: number }[] }> {
    const now = new Date()
    const format = (date: Date): string =>
      `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")} ` +
      `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(credential.uid !== "" ? { "X-User-Id": credential.uid } : {}),
        ...(credential.enterpriseId !== undefined && credential.enterpriseId !== ""
          ? { "X-Enterprise-Id": credential.enterpriseId, "X-Tenant-Id": credential.enterpriseId }
          : {}),
        ...(credential.domain !== "" ? { "X-Domain": credential.domain } : {}),
      },
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: "p_tcaca",
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const envelope = await this.readEnvelope(response)
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`workbuddy credits failed (http ${response.status}): ${envelope.msg.slice(0, 160)}`)
    }
    const wrapper = envelope.data === null || typeof envelope.data !== "object"
      ? {}
      : envelope.data as Record<string, unknown>
    const responseObj = wrapper.Response === null || typeof wrapper.Response !== "object"
      ? {}
      : wrapper.Response as Record<string, unknown>
    const data = responseObj.Data === null || typeof responseObj.Data !== "object"
      ? {}
      : responseObj.Data as Record<string, unknown>
    const rawAccounts = Array.isArray(data.Accounts) ? data.Accounts : []
    const accounts: { packageName: string; remain: number; size: number }[] = []
    let total = 0
    for (const raw of rawAccounts) {
      if (raw === null || typeof raw !== "object") continue
      const account = raw as Record<string, unknown>
      const num = (key: string): number => {
        const v = account[key]
        return typeof v === "number" ? v : 0
      }
      const size = num("CycleCapacitySize")
      const cycleRemain = num("CycleCapacityRemain")
      const cycleUsed = num("CycleCapacityUsed")
      const capacityRemain = num("CapacityRemain")
      const remain = size > 0 ? cycleRemain
        : cycleRemain > 0 || cycleUsed > 0 ? cycleRemain
        : capacityRemain
      const clamped = Math.max(remain, 0)
      total += clamped
      accounts.push({
        packageName: typeof account.PackageName === "string" ? account.PackageName : "(unnamed)",
        remain: clamped,
        size: size > 0 ? size : num("CapacitySize"),
      })
    }
    return { total, accounts }
  }

  private async readEnvelope(response: Response): Promise<{ code: number; msg: string; data: unknown }> {
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
    }
    const document = parsed as Record<string, unknown>
    return {
      code: typeof document.code === "number" ? document.code : 0,
      msg: typeof document.msg === "string" ? document.msg : "",
      data: "data" in document ? document.data : undefined,
    }
  }

  private errorBodyLimit(): number {
    return ERROR_BODY_LIMIT
  }
}