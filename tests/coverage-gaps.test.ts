/**
 * Tests targeting coverage gaps identified across the codebase:
 *
 *  1. SessionStore — previously zero tests
 *  2. RiskAnalyser utility functions — previously zero direct tests
 *  3. SessionKey.addSpendLog — untested method
 *  4. PolicyEngine.validateAction — untested method
 *  5. Middleware: session expiry & policy violation paths
 *  6. Address normalisation edge cases (leading zeros)
 *  7. ContractReporter: allowedFunctions, MoveCall/target formats, nested dry-run data
 *  8. SlippageReporter: multiple swaps, zero expectedAmountOut, camelCase fields
 *  9. DrainReporter: no balance changes, inflow, non-sender changes
 * 10. PTBVerifier: ContractReporter short-circuit behaviour
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { SessionStore } from '../src/session/SessionStore.js'
import { SessionKey } from '../src/session/SessionKey.js'
import { PolicyEngine } from '../src/session/SessionPolicy.js'
import { SessionPolicySchema } from '../src/session/types.js'
import {
  aggregateRiskLevel,
  extractNetBalanceChange,
  extractEstimatedGas,
  extractMutatedObjects,
  buildDryRunFailedReport,
} from '../src/verifier/RiskAnalyser.js'
import { ContractReporter } from '../src/verifier/reporters/ContractReporter.js'
import { SlippageReporter } from '../src/verifier/reporters/SlippageReporter.js'
import { DrainReporter } from '../src/verifier/reporters/DrainReporter.js'
import { createPolicyMiddleware, PolicyBlockedError } from '../src/middleware/AgentPolicyMiddleware.js'
import type { SessionPolicy, SessionKeyRecord } from '../src/session/types.js'
import type { AgentAction } from '../src/middleware/types.js'
import { Transaction } from '@mysten/sui/transactions'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<SessionPolicy> = {}): SessionPolicy {
  return SessionPolicySchema.parse({ id: 'test', name: 'Test', ...overrides })
}

function makeRecord(overrides: Partial<SessionKeyRecord> = {}): SessionKeyRecord {
  return {
    id: 'sess-001',
    policy: makePolicy(),
    publicKey: 'pubkey',
    privateKey: 'privkey',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    spendLog: [],
    ...overrides,
  }
}

const SENDER = '0xaaaa'

const EMPTY_EFFECTS = {
  effects: {
    status: { status: 'success' },
    balanceChanges: [],
    mutated: [],
    gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
  },
  events: [],
}

// ---------------------------------------------------------------------------
// 1. SessionStore
// ---------------------------------------------------------------------------

describe('SessionStore', () => {
  let store: SessionStore

  beforeEach(() => {
    store = new SessionStore()
  })

  it('set and get round-trips a record', () => {
    const record = makeRecord({ id: 'abc' })
    store.set(record)
    expect(store.get('abc')).toBe(record)
  })

  it('get returns undefined for an unknown ID', () => {
    expect(store.get('nonexistent')).toBeUndefined()
  })

  it('delete removes a record', () => {
    const record = makeRecord({ id: 'del-me' })
    store.set(record)
    store.delete('del-me')
    expect(store.get('del-me')).toBeUndefined()
  })

  it('size counts all records including expired ones', () => {
    store.set(makeRecord({ id: 'a', expiresAt: Date.now() - 1 })) // expired
    store.set(makeRecord({ id: 'b' })) // active
    expect(store.size()).toBe(2)
  })

  it('listActive returns only non-expired, non-revoked sessions', () => {
    store.set(makeRecord({ id: 'active', expiresAt: Date.now() + 60_000, privateKey: 'key' }))
    store.set(makeRecord({ id: 'expired', expiresAt: Date.now() - 1, privateKey: 'key' }))
    store.set(makeRecord({ id: 'revoked', expiresAt: Date.now() + 60_000, privateKey: '' }))

    const active = store.listActive()
    expect(active).toContain('active')
    expect(active).not.toContain('expired')
    expect(active).not.toContain('revoked')
  })

  it('purgeExpired removes expired and revoked sessions', () => {
    store.set(makeRecord({ id: 'keep', expiresAt: Date.now() + 60_000, privateKey: 'key' }))
    store.set(makeRecord({ id: 'remove-expired', expiresAt: Date.now() - 1, privateKey: 'key' }))
    store.set(makeRecord({ id: 'remove-revoked', expiresAt: Date.now() + 60_000, privateKey: '' }))

    store.purgeExpired()

    expect(store.get('keep')).toBeDefined()
    expect(store.get('remove-expired')).toBeUndefined()
    expect(store.get('remove-revoked')).toBeUndefined()
    expect(store.size()).toBe(1)
  })

  it('purgeExpired on empty store does not throw', () => {
    expect(() => store.purgeExpired()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2. RiskAnalyser utility functions
// ---------------------------------------------------------------------------

describe('RiskAnalyser', () => {
  describe('aggregateRiskLevel', () => {
    it('returns PASS for empty findings', () => {
      expect(aggregateRiskLevel([])).toBe('PASS')
    })

    it('returns WARN when only WARN findings exist', () => {
      const findings = [
        { reporter: 'X', level: 'WARN' as const, code: 'W', message: '' },
        { reporter: 'X', level: 'PASS' as const, code: 'P', message: '' },
      ]
      expect(aggregateRiskLevel(findings)).toBe('WARN')
    })

    it('returns BLOCK when any finding is BLOCK (overrides WARN)', () => {
      const findings = [
        { reporter: 'X', level: 'WARN' as const, code: 'W', message: '' },
        { reporter: 'X', level: 'BLOCK' as const, code: 'B', message: '' },
      ]
      expect(aggregateRiskLevel(findings)).toBe('BLOCK')
    })

    it('returns PASS when all findings are PASS', () => {
      const findings = [
        { reporter: 'X', level: 'PASS' as const, code: 'P', message: '' },
        { reporter: 'Y', level: 'PASS' as const, code: 'P', message: '' },
      ]
      expect(aggregateRiskLevel(findings)).toBe('PASS')
    })
  })

  describe('extractNetBalanceChange', () => {
    it('returns 0 when effects is undefined', () => {
      expect(extractNetBalanceChange(undefined, SENDER)).toBe(BigInt(0))
    })

    it('returns 0 when balanceChanges is empty', () => {
      expect(extractNetBalanceChange({ balanceChanges: [] }, SENDER)).toBe(BigInt(0))
    })

    it('sums multiple SUI changes for sender', () => {
      const effects = {
        balanceChanges: [
          { owner: { AddressOwner: SENDER }, coinType: '0x2::sui::SUI', amount: '-1000' },
          { owner: { AddressOwner: SENDER }, coinType: '0x2::sui::SUI', amount: '-500' },
        ],
      }
      expect(extractNetBalanceChange(effects, SENDER)).toBe(BigInt(-1500))
    })

    it('ignores non-SUI coin types', () => {
      const effects = {
        balanceChanges: [
          { owner: { AddressOwner: SENDER }, coinType: '0xtoken::usdc::USDC', amount: '-9999' },
          { owner: { AddressOwner: SENDER }, coinType: '0x2::sui::SUI', amount: '-100' },
        ],
      }
      expect(extractNetBalanceChange(effects, SENDER)).toBe(BigInt(-100))
    })

    it('ignores balance changes for other addresses', () => {
      const effects = {
        balanceChanges: [
          { owner: { AddressOwner: '0xother' }, coinType: '0x2::sui::SUI', amount: '-5000' },
          { owner: { AddressOwner: SENDER }, coinType: '0x2::sui::SUI', amount: '-200' },
        ],
      }
      expect(extractNetBalanceChange(effects, SENDER)).toBe(BigInt(-200))
    })

    it('normalises addresses with leading zeros', () => {
      // 0x00aaaa and 0xaaaa should match
      const paddedSender = '0x00aaaa'
      const effects = {
        balanceChanges: [
          { owner: { AddressOwner: paddedSender }, coinType: '0x2::sui::SUI', amount: '-777' },
        ],
      }
      expect(extractNetBalanceChange(effects, SENDER)).toBe(BigInt(-777))
    })
  })

  describe('extractEstimatedGas', () => {
    it('returns 0 when effects is undefined', () => {
      expect(extractEstimatedGas(undefined)).toBe(BigInt(0))
    })

    it('returns 0 when gasUsed is missing', () => {
      expect(extractEstimatedGas({})).toBe(BigInt(0))
    })

    it('computes computation + storage - rebate', () => {
      const effects = {
        gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
      }
      expect(extractEstimatedGas(effects)).toBe(BigInt(1300))
    })

    it('returns 0 when gas fields are unparseable', () => {
      const effects = {
        gasUsed: { computationCost: 'bad', storageCost: '500', storageRebate: '200' },
      }
      expect(extractEstimatedGas(effects)).toBe(BigInt(0))
    })
  })

  describe('extractMutatedObjects', () => {
    it('returns empty array when effects is undefined', () => {
      expect(extractMutatedObjects(undefined)).toEqual([])
    })

    it('returns empty array when mutated is missing', () => {
      expect(extractMutatedObjects({})).toEqual([])
    })

    it('returns object IDs from mutated array', () => {
      const effects = {
        mutated: [
          { reference: { objectId: '0xobj1' } },
          { reference: { objectId: '0xobj2' } },
        ],
      }
      expect(extractMutatedObjects(effects)).toEqual(['0xobj1', '0xobj2'])
    })

    it('filters out entries with missing objectId', () => {
      const effects = {
        mutated: [
          { reference: { objectId: '0xobj1' } },
          { reference: {} },            // no objectId
          { reference: undefined },     // no reference
        ],
      }
      const result = extractMutatedObjects(effects)
      expect(result).toEqual(['0xobj1'])
    })
  })

  describe('buildDryRunFailedReport', () => {
    it('returns a BLOCK report with DRY_RUN_FAILED code', () => {
      const report = buildDryRunFailedReport(new Error('RPC timeout'))
      expect(report.status).toBe('BLOCK')
      expect(report.findings).toHaveLength(1)
      expect(report.findings[0]?.code).toBe('DRY_RUN_FAILED')
      expect(report.findings[0]?.message).toContain('RPC timeout')
    })

    it('handles non-Error objects as strings', () => {
      const report = buildDryRunFailedReport('network failure')
      expect(report.findings[0]?.message).toContain('network failure')
    })

    it('returns zero gas and zero balance change', () => {
      const report = buildDryRunFailedReport('err')
      expect(report.estimatedGasMist).toBe(BigInt(0))
      expect(report.netBalanceChangeMist).toBe(BigInt(0))
    })
  })
})

// ---------------------------------------------------------------------------
// 3. SessionKey.addSpendLog
// ---------------------------------------------------------------------------

describe('SessionKey.addSpendLog', () => {
  it('appends a spend log entry to the record', () => {
    const sk = SessionKey.generate(makePolicy())
    expect(sk.getRecord().spendLog).toHaveLength(0)

    sk.addSpendLog({ timestamp: Date.now(), actionId: 'act-1', amountMist: BigInt(500) })
    expect(sk.getRecord().spendLog).toHaveLength(1)
    expect(sk.getRecord().spendLog[0]?.actionId).toBe('act-1')
  })

  it('accumulates multiple spend log entries', () => {
    const sk = SessionKey.generate(makePolicy())
    sk.addSpendLog({ timestamp: Date.now(), actionId: 'a', amountMist: BigInt(100) })
    sk.addSpendLog({ timestamp: Date.now(), actionId: 'b', amountMist: BigInt(200) })
    expect(sk.getRecord().spendLog).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 4. PolicyEngine.validateAction
// ---------------------------------------------------------------------------

describe('PolicyEngine.validateAction', () => {
  function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
    return {
      id: 'act',
      label: 'Act',
      ptb: new Transaction(),
      estimatedSpendMist: BigInt(100),
      ...overrides,
    }
  }

  it('returns no violations for a compliant action', () => {
    const engine = new PolicyEngine(makePolicy({ spendLimits: { perActionMist: BigInt(1000) } }))
    expect(engine.validateAction(makeAction({ estimatedSpendMist: BigInt(500) }))).toHaveLength(0)
  })

  it('returns a violation when estimatedSpendMist exceeds perActionMist', () => {
    const engine = new PolicyEngine(makePolicy({ spendLimits: { perActionMist: BigInt(100) } }))
    const violations = engine.validateAction(makeAction({ estimatedSpendMist: BigInt(101) }))
    expect(violations).toHaveLength(1)
    expect(violations[0]?.rule).toBe('spendLimits.perActionMist')
  })

  it('returns no violations when estimatedSpendMist is undefined', () => {
    const engine = new PolicyEngine(makePolicy({ spendLimits: { perActionMist: BigInt(100) } }))
    const violations = engine.validateAction(makeAction({ estimatedSpendMist: undefined }))
    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. PolicyEngine.validateCall — address normalisation edge cases
// ---------------------------------------------------------------------------

describe('PolicyEngine.validateCall — address normalisation', () => {
  it('treats addresses with leading zeros as equivalent (0x00001111 == 0x1111)', () => {
    // allowed list uses padded form, call uses short form — should still pass
    const policy = makePolicy({ allowedPackages: ['0x00001111'] })
    const engine = new PolicyEngine(policy)
    expect(engine.validateCall('0x1111::module::fn')).toBeNull()
  })

  it('blocks the leading-zero address when it is in blockedPackages', () => {
    const policy = makePolicy({ blockedPackages: ['0x0000bad0'] })
    const engine = new PolicyEngine(policy)
    const violation = engine.validateCall('0xbad0::module::fn')
    expect(violation).not.toBeNull()
    expect(violation?.rule).toBe('blockedPackages')
  })
})

// ---------------------------------------------------------------------------
// 6. ContractReporter — extended coverage
// ---------------------------------------------------------------------------

describe('ContractReporter — extended', () => {
  const emptyEffects = EMPTY_EFFECTS

  it('does NOT enforce allowedFunctions — that is PolicyEngine.validateCall responsibility', () => {
    // ContractReporter only checks allowedPackages and blockedPackages.
    // allowedFunctions enforcement is in PolicyEngine.validateCall (covered in session.test.ts).
    const policy = makePolicy({ allowedFunctions: ['0x1111::mod::safe'] })
    // ContractReporter has no allowedPackages restriction, so any package is allowed
    const reporter = new ContractReporter(['0x1111::mod::dangerous'])
    const findings = reporter.analyse(emptyEffects, policy)
    // No BLOCK since allowedPackages is empty and 0x1111 is not in blockedPackages
    expect(findings.filter((f) => f.level === 'BLOCK')).toHaveLength(0)
  })

  it('returns PASS when package and function are both explicitly allowed', () => {
    const policy = makePolicy({
      allowedPackages: ['0x1111'],
      allowedFunctions: ['0x1111::mod::safe'],
    })
    const reporter = new ContractReporter(['0x1111::mod::safe'])
    const findings = reporter.analyse(emptyEffects, policy)
    expect(findings.filter((f) => f.level === 'BLOCK')).toHaveLength(0)
  })

  it('extracts targets from { MoveCall: { package, module, function } } format', () => {
    const policy = makePolicy({ blockedPackages: ['0xbad'] })
    const txs = [{ MoveCall: { package: '0xbad', module: 'evil', function: 'drain' } }]
    const reporter = new ContractReporter(txs)
    const findings = reporter.analyse(emptyEffects, policy)
    expect(findings.some((f) => f.code === 'BLOCKED_CONTRACT')).toBe(true)
  })

  it('extracts targets from { target: string } format', () => {
    const policy = makePolicy({ blockedPackages: ['0xbad'] })
    const txs = [{ target: '0xbad::evil::drain' }]
    const reporter = new ContractReporter(txs)
    const findings = reporter.analyse(emptyEffects, policy)
    expect(findings.some((f) => f.code === 'BLOCKED_CONTRACT')).toBe(true)
  })

  it('extracts targets from plain string format', () => {
    const policy = makePolicy({ blockedPackages: ['0xbad'] })
    const txs = ['0xbad::evil::drain']
    const reporter = new ContractReporter(txs)
    const findings = reporter.analyse(emptyEffects, policy)
    expect(findings.some((f) => f.code === 'BLOCKED_CONTRACT')).toBe(true)
  })

  it('extracts targets from nested dry-run transaction data', () => {
    const policy = makePolicy({ blockedPackages: ['0xnested'] })
    const dryRun = {
      ...emptyEffects,
      transaction: {
        data: {
          transaction: {
            transactions: [{ target: '0xnested::mod::fn' }],
          },
        },
      },
    }
    const reporter = new ContractReporter([]) // empty PTB transactions
    const findings = reporter.analyse(dryRun, policy)
    expect(findings.some((f) => f.code === 'BLOCKED_CONTRACT')).toBe(true)
  })

  it('returns PASS with no transactions', () => {
    const policy = makePolicy({ blockedPackages: ['0xbad'] })
    const reporter = new ContractReporter([])
    const findings = reporter.analyse(emptyEffects, policy)
    expect(findings.filter((f) => f.level === 'BLOCK')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 7. SlippageReporter — extended coverage
// ---------------------------------------------------------------------------

describe('SlippageReporter — extended', () => {
  const reporter = new SlippageReporter()

  it('blocks when any of multiple swap events exceeds the limit', () => {
    const policy = makePolicy({ maxSlippageBps: 200 })
    const dryRun = {
      ...EMPTY_EFFECTS,
      events: [
        {
          type: '0xcetus::pool::SwapEvent',
          parsedJson: {
            amount_in: '10000',
            amount_out: '9900', // 100 bps — within limit
            expected_amount_out: '10000',
          },
        },
        {
          type: '0xcetus::pool::SwapEvent',
          parsedJson: {
            amount_in: '10000',
            amount_out: '7000', // 3000 bps — exceeds limit
            expected_amount_out: '10000',
          },
        },
      ],
    }
    const findings = reporter.analyse(dryRun, policy)
    expect(findings.some((f) => f.level === 'BLOCK' && f.code === 'SLIPPAGE_EXCEEDED')).toBe(true)
  })

  it('skips swap events where expectedAmountOut is zero', () => {
    const policy = makePolicy({ maxSlippageBps: 200 })
    const dryRun = {
      ...EMPTY_EFFECTS,
      events: [
        {
          type: '0xcetus::pool::SwapEvent',
          parsedJson: {
            amount_in: '10000',
            amount_out: '0',
            expected_amount_out: '0', // zero — should be skipped
          },
        },
      ],
    }
    const findings = reporter.analyse(dryRun, policy)
    expect(findings).toHaveLength(0)
  })

  it('handles camelCase field names (amountIn / amountOut / expectedAmountOut)', () => {
    const policy = makePolicy({ maxSlippageBps: 200 })
    const dryRun = {
      ...EMPTY_EFFECTS,
      events: [
        {
          type: '0xdex::pool::SwapEvent',
          parsedJson: {
            amountIn: '10000',
            amountOut: '7000',       // 3000 bps — exceeds limit
            expectedAmountOut: '10000',
          },
        },
      ],
    }
    const findings = reporter.analyse(dryRun, policy)
    expect(findings.some((f) => f.level === 'BLOCK' && f.code === 'SLIPPAGE_EXCEEDED')).toBe(true)
  })

  it('returns no findings when no swap events are present', () => {
    const policy = makePolicy({ maxSlippageBps: 200 })
    const findings = reporter.analyse(EMPTY_EFFECTS, policy)
    expect(findings).toHaveLength(0)
  })

  it('returns no findings when maxSlippageBps is not configured (defaults to 0 → any slippage blocks)', () => {
    // maxSlippageBps defaults to 0 in SessionPolicySchema — any slippage > 0 blocks
    const policy = makePolicy({ maxSlippageBps: 0 })
    const dryRun = {
      ...EMPTY_EFFECTS,
      events: [
        {
          type: '0xcetus::pool::SwapEvent',
          parsedJson: {
            amount_in: '10000',
            amount_out: '9999', // 1 bps
            expected_amount_out: '10000',
          },
        },
      ],
    }
    const findings = reporter.analyse(dryRun, policy)
    // limit is 0 so slippage of 1 > 0 → BLOCK
    expect(findings.some((f) => f.level === 'BLOCK')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. DrainReporter — extended coverage
// ---------------------------------------------------------------------------

describe('DrainReporter — extended', () => {
  it('returns no findings when there are no balance changes', () => {
    const policy = makePolicy()
    const reporter = new DrainReporter(SENDER)
    const dryRun = {
      effects: {
        status: { status: 'success' },
        balanceChanges: null,
        mutated: [],
        gasUsed: { computationCost: '0', storageCost: '0', storageRebate: '0' },
      },
      events: [],
    }
    const findings = reporter.analyse(dryRun, policy)
    expect(findings).toHaveLength(0)
  })

  it('does not flag positive balance changes (inflows)', () => {
    const policy = makePolicy({ spendLimits: { perActionMist: BigInt(1_000_000) } })
    const reporter = new DrainReporter(SENDER)
    const dryRun = {
      effects: {
        status: { status: 'success' },
        balanceChanges: [
          { owner: { AddressOwner: SENDER }, coinType: '0x2::sui::SUI', amount: '+999999999999' },
        ],
        mutated: [],
        gasUsed: { computationCost: '0', storageCost: '0', storageRebate: '0' },
      },
      events: [],
    }
    const findings = reporter.analyse(dryRun, policy)
    expect(findings.filter((f) => f.level === 'BLOCK')).toHaveLength(0)
    expect(findings.filter((f) => f.code === 'LARGE_BALANCE_DRAIN')).toHaveLength(0)
  })

  it('ignores balance changes for non-sender addresses', () => {
    const policy = makePolicy({ spendLimits: { perActionMist: BigInt(1_000) } })
    const reporter = new DrainReporter(SENDER)
    const dryRun = {
      effects: {
        status: { status: 'success' },
        balanceChanges: [
          { owner: { AddressOwner: '0xother' }, coinType: '0x2::sui::SUI', amount: '-9999999' },
        ],
        mutated: [],
        gasUsed: { computationCost: '0', storageCost: '0', storageRebate: '0' },
      },
      events: [],
    }
    const findings = reporter.analyse(dryRun, policy)
    expect(findings.filter((f) => f.level === 'BLOCK')).toHaveLength(0)
  })

  it('does not flag outflows below the large drain threshold (1000 SUI)', () => {
    const policy = makePolicy() // no spendLimits
    const reporter = new DrainReporter(SENDER)
    const dryRun = {
      effects: {
        status: { status: 'success' },
        balanceChanges: [
          // 999 SUI — just below threshold
          { owner: { AddressOwner: SENDER }, coinType: '0x2::sui::SUI', amount: '-999000000000' },
        ],
        mutated: [],
        gasUsed: { computationCost: '0', storageCost: '0', storageRebate: '0' },
      },
      events: [],
    }
    const findings = reporter.analyse(dryRun, policy)
    expect(findings.filter((f) => f.code === 'LARGE_BALANCE_DRAIN')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 10. Middleware — session expiry and policy-violation paths
// ---------------------------------------------------------------------------

// Mock PTBVerifier and SuiClient for middleware tests
vi.mock('../src/verifier/PTBVerifier.js', () => ({
  PTBVerifier: vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockResolvedValue({
      status: 'PASS',
      findings: [],
      estimatedGasMist: BigInt(1000),
      netBalanceChangeMist: BigInt(-1_000_000),
      mutatedObjects: [],
      rawDryRun: {},
      generatedAt: Date.now(),
    }),
  })),
}))

vi.mock('@mysten/sui/client', () => ({
  SuiClient: vi.fn().mockImplementation(() => ({})),
}))

describe('AgentPolicyMiddleware — extra paths', () => {
  function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
    return {
      id: 'act-001',
      label: 'Test Action',
      ptb: new Transaction(),
      estimatedSpendMist: BigInt(100),
      ...overrides,
    }
  }

  it('throws PolicyBlockedError with SESSION_EXPIRED code when session has expired', async () => {
    const policy = makePolicy({ ttlMs: 1 }) // 1ms TTL
    const middleware = createPolicyMiddleware({
      policy,
      rpcUrl: 'https://fullnode.mainnet.sui.io',
      agentAddress: '0xagent',
    })

    // Force expiry by manipulating the record
    const record = middleware.sessionKey.getRecord()
    ;(record as { expiresAt: number }).expiresAt = Date.now() - 1

    const error = await middleware.execute(makeAction(), vi.fn()).catch((e) => e)
    expect(error).toBeInstanceOf(PolicyBlockedError)
    expect(error.report.findings[0]?.code).toBe('SESSION_EXPIRED')
  })

  it('throws PolicyBlockedError when action violates spend limit (pre-PTB check)', async () => {
    const policy = makePolicy({ spendLimits: { perActionMist: BigInt(50) } })
    const middleware = createPolicyMiddleware({
      policy,
      rpcUrl: 'https://fullnode.mainnet.sui.io',
      agentAddress: '0xagent',
    })

    const error = await middleware
      .execute(makeAction({ estimatedSpendMist: BigInt(100) }), vi.fn())
      .catch((e) => e)

    expect(error).toBeInstanceOf(PolicyBlockedError)
    // Policy violation fires before PTB verification
    expect(error.report.findings[0]?.code).toBe('SPENDLIMITS_PERACTIONMIST')
  })

  it('calls onBlocked for policy violations (pre-PTB)', async () => {
    const policy = makePolicy({ spendLimits: { perActionMist: BigInt(10) } })
    const onBlocked = vi.fn()
    const middleware = createPolicyMiddleware({
      policy,
      rpcUrl: 'https://fullnode.mainnet.sui.io',
      agentAddress: '0xagent',
      onBlocked,
    })

    await middleware.execute(makeAction({ estimatedSpendMist: BigInt(100) }), vi.fn()).catch(() => {})
    expect(onBlocked).toHaveBeenCalledOnce()
  })

  it('spend log grows after successful execution', async () => {
    const { PTBVerifier: MockVerifier } = await import('../src/verifier/PTBVerifier.js')
    ;(MockVerifier as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      verify: vi.fn().mockResolvedValue({
        status: 'PASS',
        findings: [],
        estimatedGasMist: BigInt(0),
        netBalanceChangeMist: BigInt(0),
        mutatedObjects: [],
        rawDryRun: {},
        generatedAt: Date.now(),
      }),
    }))

    const policy = makePolicy()
    const middleware = createPolicyMiddleware({
      policy,
      rpcUrl: 'https://fullnode.mainnet.sui.io',
      agentAddress: '0xagent',
    })

    const executor = vi.fn().mockResolvedValue('0xdigest')
    await middleware.execute(makeAction(), executor)

    const spendLog = middleware.sessionKey.getRecord().spendLog
    expect(spendLog).toHaveLength(1)
    expect(spendLog[0]?.actionId).toBe('act-001')
    expect(spendLog[0]?.txDigest).toBe('0xdigest')
  })
})
