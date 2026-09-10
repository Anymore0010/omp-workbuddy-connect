/**
 * Credential store with demand-driven refresh for the omp WorkBuddy connect
 * extension. Reuses the desktop app's sign-in; refreshes near expiry through
 * the upstream and persists an owned copy under the omp home.
 */

import {
  readDesktopCredential,
  readOwnedCredential,
  writeOwnedCredential,
  preferCredential,
  expiresSoon,
  type WorkBuddyCredential,
} from "./auth"
import type { WorkBuddyUpstreamClient } from "./upstream"

const REFRESH_MARGIN_MS = 5 * 60 * 1000

export class WorkBuddyCredentialStore {
  private cached: WorkBuddyCredential | undefined

  constructor(private readonly client: WorkBuddyUpstreamClient) {}

  /** The effective credential, refreshing it near expiry if possible. */
  async current(): Promise<WorkBuddyCredential | undefined> {
    if (this.cached !== undefined && !expiresSoon(this.cached, REFRESH_MARGIN_MS)) {
      return this.cached
    }
    const owned = readOwnedCredential()
    const desktop = readDesktopCredential()
    const candidate = preferCredential(owned, desktop)
    if (candidate === undefined) {
      this.cached = undefined
      return undefined
    }
    if (expiresSoon(candidate, REFRESH_MARGIN_MS) && candidate.refreshToken !== "") {
      await this.refresh(candidate)
    }
    this.cached = candidate
    return candidate
  }

  private async refresh(credential: WorkBuddyCredential): Promise<void> {
    try {
      const outcome = await this.client.refreshToken(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        refreshToken: outcome.refreshToken ?? credential.refreshToken,
        ...(outcome.expiresInSec !== undefined
          ? { expiresAtMs: Date.now() + outcome.expiresInSec * 1000 }
          : {}),
        ...(outcome.domain !== undefined ? { domain: outcome.domain } : {}),
        source: "owned",
      }
      writeOwnedCredential(refreshed)
      this.cached = refreshed
    } catch {
      // keep the stale credential; the upstream request will surface the error
    }
  }
}