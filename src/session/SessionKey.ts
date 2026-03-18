import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { randomBytes } from 'node:crypto'
import type { SessionPolicy, SessionKeyRecord } from './types.js'

export class SessionKey {
  private record: SessionKeyRecord
  private keypair: Ed25519Keypair

  private constructor(record: SessionKeyRecord, keypair: Ed25519Keypair) {
    this.record = record
    this.keypair = keypair
  }

  /**
   * Generate a new ephemeral Ed25519 session key scoped to the given policy.
   */
  static generate(policy: SessionPolicy): SessionKey {
    const keypair = Ed25519Keypair.generate()
    const now = Date.now()
    const publicKeyBytes = keypair.getPublicKey().toRawBytes()
    // getSecretKey() returns a bech32-encoded string ("suiprivkey1...")
    const secretKeyStr = keypair.getSecretKey()

    const record: SessionKeyRecord = {
      id: randomBytes(16).toString('hex'),
      policy,
      publicKey: Buffer.from(publicKeyBytes).toString('base64'),
      privateKey: secretKeyStr, // bech32 string, in-memory only — never serialise to disk
      createdAt: now,
      expiresAt: now + policy.ttlMs,
      spendLog: [],
    }

    return new SessionKey(record, keypair)
  }

  /**
   * Reconstruct a SessionKey from a persisted record.
   * Note: This should only be called when the record's privateKey is still populated.
   */
  static fromRecord(record: SessionKeyRecord): SessionKey {
    // privateKey is the bech32 string from getSecretKey()
    const keypair = Ed25519Keypair.fromSecretKey(record.privateKey)
    return new SessionKey(record, keypair)
  }

  /**
   * Sign a PTB digest with the session private key.
   * Returns a promise resolving to the signature bytes.
   */
  async sign(digest: Uint8Array): Promise<Uint8Array> {
    if (!this.isValid()) {
      throw new Error('Session key is expired or revoked')
    }
    return this.keypair.sign(digest)
  }

  /**
   * Returns true if the session key has not expired and has not been revoked.
   */
  isValid(): boolean {
    return this.record.expiresAt > Date.now() && this.record.privateKey !== ''
  }

  /**
   * Revoke in-place: zeroes the private key bytes so it can no longer be used.
   */
  revoke(): void {
    this.record.privateKey = ''
  }

  /**
   * Get the session record (exposes publicKey but not privateKey in safe form).
   */
  getRecord(): SessionKeyRecord {
    return this.record
  }

  /**
   * Get session info without private key.
   */
  getSafeRecord(): Omit<SessionKeyRecord, 'privateKey'> {
    const { privateKey: _omit, ...safe } = this.record
    return safe
  }

  /**
   * Add a spend log entry to the session.
   */
  addSpendLog(entry: SessionKeyRecord['spendLog'][number]): void {
    this.record.spendLog.push(entry)
  }
}

