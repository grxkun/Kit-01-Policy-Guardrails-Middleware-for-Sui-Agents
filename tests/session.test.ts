import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SessionKey } from '../src/session/SessionKey.js'
import { PolicyEngine } from '../src/session/SessionPolicy.js'
import { SessionPolicySchema } from '../src/session/types.js'
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519'
import type { SessionPolicy, SessionKeyRecord, SpendLogEntry } from '../src/session/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<SessionPolicy> = {}): SessionPolicy {
  return SessionPolicySchema.parse({
    id: 'test-policy',
    name: 'Test Policy',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// SessionKey tests
// ---------------------------------------------------------------------------

describe('SessionKey', () => {
  it('generates a valid Ed25519 keypair', () => {
    const policy = makePolicy()
    const sk = SessionKey.generate(policy)
    const record = sk.getRecord()

    expect(record.publicKey).toBeTruthy()
    expect(record.privateKey).toBeTruthy()
    expect(record.id).toHaveLength(32) // 16 bytes hex

    // Public key should be valid base64 encoding of 32 bytes
    const pubKeyBytes = Buffer.from(record.publicKey, 'base64')
    expect(pubKeyBytes).toHaveLength(32)
  })

  it('expires after TTL', () => {
    const policy = makePolicy({ ttlMs: 1000 })
    const sk = SessionKey.generate(policy)

    expect(sk.isValid()).toBe(true)

    // Simulate time passing: mock Date.now to be after expiry
    const record = sk.getRecord()
    const originalExpiresAt = record.expiresAt

    // Manipulate the record's expiresAt to simulate expiry
    ;(record as { expiresAt: number }).expiresAt = Date.now() - 1

    expect(sk.isValid()).toBe(false)

    // Restore
    ;(record as { expiresAt: number }).expiresAt = originalExpiresAt
  })

  it('is revocable (zeroes private key)', () => {
    const policy = makePolicy()
    const sk = SessionKey.generate(policy)

    expect(sk.isValid()).toBe(true)

    sk.revoke()

    expect(sk.isValid()).toBe(false)
    expect(sk.getRecord().privateKey).toBe('')
  })

  it('signs a digest that verifies with its public key', async () => {
    const policy = makePolicy()
    const sk = SessionKey.generate(policy)
    const record = sk.getRecord()

    const testDigest = new Uint8Array(32).fill(0xab)
    const signature = await sk.sign(testDigest)

    expect(signature).toBeInstanceOf(Uint8Array)
    expect(signature.length).toBeGreaterThan(0)

    // Verify the signature with the public key
    const pubKeyBytes = Buffer.from(record.publicKey, 'base64')
    const pubKey = new Ed25519PublicKey(pubKeyBytes)
    const isValid = await pubKey.verify(testDigest, signature)
    expect(isValid).toBe(true)
  })

  it('throws when signing with an expired/revoked key', async () => {
    const policy = makePolicy()
    const sk = SessionKey.generate(policy)
    sk.revoke()

    await expect(sk.sign(new Uint8Array(32))).rejects.toThrow('expired or revoked')
  })

  it('getSafeRecord does not expose privateKey', () => {
    const policy = makePolicy()
    const sk = SessionKey.generate(policy)
    const safe = sk.getSafeRecord()

    expect('privateKey' in safe).toBe(false)
    expect(safe.publicKey).toBeTruthy()
  })

  it('fromRecord reconstructs a SessionKey', async () => {
    const policy = makePolicy()
    const sk1 = SessionKey.generate(policy)
    const record = sk1.getRecord()

    const sk2 = SessionKey.fromRecord(record)
    const digest = new Uint8Array(32).fill(0x55)
    const sig1 = await sk1.sign(digest)
    const sig2 = await sk2.sign(digest)

    expect(Buffer.from(sig1).toString('hex')).toBe(Buffer.from(sig2).toString('hex'))
  })
})

// ---------------------------------------------------------------------------
// PolicyEngine tests
// ---------------------------------------------------------------------------

describe('PolicyEngine', () => {
  describe('validateCall', () => {
    it('blocks calls to packages not in allowedPackages', () => {
      const policy = makePolicy({
        allowedPackages: ['0x1111'],
      })
      const engine = new PolicyEngine(policy)
      const violation = engine.validateCall('0x2222::module::fn')
      expect(violation).not.toBeNull()
      expect(violation?.rule).toBe('allowedPackages')
    })

    it('allows all calls when allowedPackages is empty', () => {
      const policy = makePolicy({ allowedPackages: [] })
      const engine = new PolicyEngine(policy)
      const violation = engine.validateCall('0xdeadbeef::module::fn')
      expect(violation).toBeNull()
    })

    it('always blocks calls to blockedPackages', () => {
      const policy = makePolicy({
        blockedPackages: ['0xbad0'],
      })
      const engine = new PolicyEngine(policy)
      const violation = engine.validateCall('0xbad0::evil::drain')
      expect(violation).not.toBeNull()
      expect(violation?.rule).toBe('blockedPackages')
    })

    it('blocks calls to functions not in allowedFunctions when list is non-empty', () => {
      const policy = makePolicy({
        allowedFunctions: ['0x1111::module::safe_fn'],
      })
      const engine = new PolicyEngine(policy)
      const violation = engine.validateCall('0x1111::module::other_fn')
      expect(violation).not.toBeNull()
      expect(violation?.rule).toBe('allowedFunctions')
    })

    it('allows calls matching allowedFunctions', () => {
      const policy = makePolicy({
        allowedFunctions: ['0x1111::module::safe_fn'],
      })
      const engine = new PolicyEngine(policy)
      const violation = engine.validateCall('0x1111::module::safe_fn')
      expect(violation).toBeNull()
    })

    it('blockedPackages takes precedence over allowedPackages', () => {
      const policy = makePolicy({
        allowedPackages: ['0x1111'],
        blockedPackages: ['0x1111'],
      })
      const engine = new PolicyEngine(policy)
      const violation = engine.validateCall('0x1111::module::fn')
      expect(violation).not.toBeNull()
      expect(violation?.rule).toBe('blockedPackages')
    })
  })

  describe('validateSpend', () => {
    it('blocks single action exceeding perActionMist', () => {
      const policy = makePolicy({
        spendLimits: {
          perActionMist: BigInt(100),
        },
      })
      const engine = new PolicyEngine(policy)
      const violation = engine.validateSpend(BigInt(101), [])
      expect(violation).not.toBeNull()
      expect(violation?.rule).toBe('spendLimits.perActionMist')
    })

    it('allows action exactly at perActionMist limit', () => {
      const policy = makePolicy({
        spendLimits: {
          perActionMist: BigInt(100),
        },
      })
      const engine = new PolicyEngine(policy)
      const violation = engine.validateSpend(BigInt(100), [])
      expect(violation).toBeNull()
    })

    it('blocks rolling window total exceeding rollingWindowMist', () => {
      const policy = makePolicy({
        spendLimits: {
          rollingWindowMist: BigInt(500),
          rollingWindowMs: 3_600_000,
        },
      })
      const engine = new PolicyEngine(policy)

      const spendLog: SpendLogEntry[] = [
        { timestamp: Date.now() - 1000, actionId: 'a1', amountMist: BigInt(300) },
        { timestamp: Date.now() - 2000, actionId: 'a2', amountMist: BigInt(150) },
      ]

      const violation = engine.validateSpend(BigInt(100), spendLog)
      expect(violation).not.toBeNull()
      expect(violation?.rule).toBe('spendLimits.rollingWindowMist')
    })

    it('only counts spend entries within rollingWindowMs', () => {
      const policy = makePolicy({
        spendLimits: {
          rollingWindowMist: BigInt(500),
          rollingWindowMs: 3_600_000, // 1 hour
        },
      })
      const engine = new PolicyEngine(policy)

      const spendLog: SpendLogEntry[] = [
        // Outside the 1-hour window
        { timestamp: Date.now() - 4_000_000, actionId: 'old', amountMist: BigInt(400) },
        // Inside the window
        { timestamp: Date.now() - 1000, actionId: 'recent', amountMist: BigInt(100) },
      ]

      // Should pass: only 100 + 100 = 200 within window < 500 limit
      const violation = engine.validateSpend(BigInt(100), spendLog)
      expect(violation).toBeNull()
    })

    it('passes when limits are not set', () => {
      const policy = makePolicy({ spendLimits: undefined })
      const engine = new PolicyEngine(policy)
      const violation = engine.validateSpend(BigInt(999_999_999), [])
      expect(violation).toBeNull()
    })
  })

  describe('isAlive', () => {
    it('returns true for a fresh session', () => {
      const policy = makePolicy({ ttlMs: 86_400_000 })
      const sk = SessionKey.generate(policy)
      const engine = new PolicyEngine(policy)
      expect(engine.isAlive(sk.getRecord())).toBe(true)
    })

    it('returns false for an expired session', () => {
      const policy = makePolicy({ ttlMs: 100 })
      const sk = SessionKey.generate(policy)
      const record = sk.getRecord()
      ;(record as { expiresAt: number }).expiresAt = Date.now() - 1
      const engine = new PolicyEngine(policy)
      expect(engine.isAlive(record)).toBe(false)
    })
  })
})
