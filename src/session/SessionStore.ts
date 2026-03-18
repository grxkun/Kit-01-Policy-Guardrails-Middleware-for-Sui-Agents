import type { SessionKeyRecord } from './types.js'

/**
 * In-memory session store with optional Walrus persistence (v0.2 feature).
 * Stores active session key records indexed by session ID.
 */
export class SessionStore {
  private store = new Map<string, SessionKeyRecord>()

  /**
   * Save or update a session record.
   * NOTE: The privateKey field must NEVER be persisted to disk or external storage.
   */
  set(record: SessionKeyRecord): void {
    this.store.set(record.id, record)
  }

  /**
   * Retrieve a session record by ID.
   */
  get(id: string): SessionKeyRecord | undefined {
    return this.store.get(id)
  }

  /**
   * Remove a session record (e.g. after revocation).
   */
  delete(id: string): void {
    this.store.delete(id)
  }

  /**
   * List all active (non-expired) session IDs.
   */
  listActive(): string[] {
    const now = Date.now()
    const active: string[] = []
    for (const [id, record] of this.store) {
      if (record.expiresAt > now && record.privateKey !== '') {
        active.push(id)
      }
    }
    return active
  }

  /**
   * Purge all expired or revoked sessions.
   */
  purgeExpired(): void {
    const now = Date.now()
    for (const [id, record] of this.store) {
      if (record.expiresAt <= now || record.privateKey === '') {
        this.store.delete(id)
      }
    }
  }

  /**
   * Total number of sessions in the store (including expired).
   */
  size(): number {
    return this.store.size
  }
}
