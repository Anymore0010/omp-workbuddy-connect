/**
 * WorkBuddy credential resolution for the omp connect extension.
 *
 * Reuses the WorkBuddy desktop app's own auth file (read-only) and keeps a
 * plugin-owned refreshed copy under the omp home so token refreshes survive
 * restarts without ever writing to the desktop app's file.
 */

import { homedir, release } from "node:os"
import { join } from "node:path"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"

export const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE"
export const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json"

const DESKTOP_RELATIVE = ["CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"] as const

export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  source: "desktop" | "owned"
}

const OWN_FORMAT_VERSION = 1

function isWsl(): boolean {
  if (process.platform !== "linux") return false
  if (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined) return true
  return release().toLowerCase().includes("microsoft")
}

function windowsPathForWsl(value?: string): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith("/")) return path
  const drive = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drive === null) return undefined
  return join("/mnt", drive[1]!.toLowerCase(), ...drive[2]!.split(/[\\/]+/u))
}

function wslDesktopAuthCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env.USERPROFILE) ?? join("/mnt/c/Users", home.split(/[\\/]/).filter(Boolean).at(-1) ?? "")
  const local = windowsPathForWsl(process.env.LOCALAPPDATA) ?? join(profile, "AppData", "Local")
  const roaming = windowsPathForWsl(process.env.APPDATA) ?? join(profile, "AppData", "Roaming")
  return [
    join(local, ...DESKTOP_RELATIVE),
    join(roaming, ...DESKTOP_RELATIVE),
  ]
}

/** Platform-default candidates for the WorkBuddy desktop auth file, in probe order. */
export function defaultDesktopAuthCandidates(): string[] {
  const home = homedir()
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", ...DESKTOP_RELATIVE)]
  }
  if (process.platform === "win32") {
    return [
      join(home, "AppData", "Local", ...DESKTOP_RELATIVE),
      join(home, "AppData", "Roaming", ...DESKTOP_RELATIVE),
    ]
  }
  if (process.platform === "linux") {
    const linux = join(home, ".config", ...DESKTOP_RELATIVE)
    return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux]
  }
  return []
}

export function resolveOmpHome(): string {
  return process.env.OMP_HOME ?? join(homedir(), ".omp")
}

export function ownedAuthPath(): string {
  return join(resolveOmpHome(), WORKBUDDY_AUTH_FILENAME)
}

function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** Parse the desktop doc in either shape: nested `{auth,account}` or flat. */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const nested = typeof document.auth === "object" && document.auth !== null
  const auth = nested ? (document.auth as Record<string, unknown>) : document
  const identity = nested && typeof document.account === "object" && document.account !== null
    ? (document.account as Record<string, unknown>)
    : document

  const accessToken = auth.accessToken
  if (typeof accessToken !== "string" || accessToken === "") return undefined

  const expiresAt = auth.expiresAt
  const refreshExpiresAt = auth.refreshExpiresAt
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
    expiresAtMs: typeof expiresAt === "number" ? expiryToMs(expiresAt) : 0,
    ...(typeof refreshExpiresAt === "number" && refreshExpiresAt > 0
      ? { refreshExpiresAtMs: expiryToMs(refreshExpiresAt) }
      : {}),
    domain: optionalString(auth.domain) ?? "",
    uid: optionalString(identity.uid) ?? "",
    enterpriseId: optionalString(identity.enterpriseId),
    nickname: optionalString(identity.nickname),
    source: "desktop",
  }
}

function parseOwnDocument(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document.version !== OWN_FORMAT_VERSION) return undefined
  const stored = document.credential
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined
  const c = stored as Record<string, unknown>
  const accessToken = c.accessToken
  if (typeof accessToken !== "string" || accessToken === "") return undefined
  return {
    accessToken,
    refreshToken: typeof c.refreshToken === "string" ? c.refreshToken : "",
    expiresAtMs: typeof c.expiresAtMs === "number" ? c.expiresAtMs : 0,
    ...(typeof c.refreshExpiresAtMs === "number" && c.refreshExpiresAtMs > 0 ? { refreshExpiresAtMs: c.refreshExpiresAtMs } : {}),
    domain: optionalString(c.domain) ?? "",
    uid: optionalString(c.uid) ?? "",
    enterpriseId: optionalString(c.enterpriseId),
    nickname: optionalString(c.nickname),
    source: "owned",
  }
}

export function readDesktopCredential(): WorkBuddyCredential | undefined {
  const override = process.env[WORKBUDDY_AUTH_FILE_ENV]
  const candidates = override ? [override] : defaultDesktopAuthCandidates()
  for (const path of candidates) {
    try {
      const credential = parseWorkBuddyAuth(readFileSync(path, "utf-8"))
      if (credential !== undefined) return credential
    } catch {
      // missing/unreadable — try next candidate
    }
  }
  return undefined
}

export function readOwnedCredential(): WorkBuddyCredential | undefined {
  try {
    return parseOwnDocument(readFileSync(ownedAuthPath(), "utf-8"))
  } catch {
    return undefined
  }
}

export function writeOwnedCredential(credential: WorkBuddyCredential): void {
  const document = {
    version: OWN_FORMAT_VERSION,
    credential: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAtMs: credential.expiresAtMs,
      refreshExpiresAtMs: credential.refreshExpiresAtMs,
      domain: credential.domain,
      uid: credential.uid,
      enterpriseId: credential.enterpriseId,
      nickname: credential.nickname,
    },
  }
  try {
    mkdirSync(resolveOmpHome(), { recursive: true })
    writeFileSync(ownedAuthPath(), JSON.stringify(document), "utf-8")
  } catch {
    // non-fatal: refresh still applies for this process lifetime
  }
}

/** Prefer whichever credential expires later; a refresh by either side wins. */
export function preferCredential(owned?: WorkBuddyCredential, desktop?: WorkBuddyCredential): WorkBuddyCredential | undefined {
  if (owned === undefined) return desktop
  if (desktop === undefined) return owned
  return (owned.expiresAtMs ?? 0) >= (desktop.expiresAtMs ?? 0) ? owned : desktop
}

export function expiresSoon(credential: WorkBuddyCredential, marginMs: number): boolean {
  if (credential.expiresAtMs <= 0) return false
  return credential.expiresAtMs <= Date.now() + marginMs
}