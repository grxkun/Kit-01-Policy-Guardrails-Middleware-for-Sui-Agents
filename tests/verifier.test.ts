import { describe, it, expect, vi } from 'vitest'
import { SlippageReporter } from '../src/verifier/reporters/SlippageReporter.js'
import { DrainReporter } from '../src/verifier/reporters/DrainReporter.js'
import { ContractReporter } from '../src/verifier/reporters/ContractReporter.js'
import { PTBVerifier } from '../src/verifier/PTBVerifier.js'
import { SessionPolicySchema } from '../src/session/types.js'
import type { SessionPolicy } from '../src/session/types.js'
import type { Reporter } from '../src/verifier/types.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<SessionPolicy> = {}): SessionPolicy {
  return SessionPolicySchema.parse({
    id: 'test',
    name: 'Test',
    ...overrides,
  })
}

const SENDER = '0xaaaa'

// ---------------------------------------------------------------------------
// Mock dry-run fixtures
// ---------------------------------------------------------------------------

const MOCK_DRY_RUN_SAFE = {
  effects: {
    status: { status: 'success' },
    balanceChanges: [
      { owner: { AddressOwner: SENDER }, coinType: '0x2::sui::SUI', amount: '-1000000' },
    ],
    mutated: [{ reference: { objectId: '0xobj1' } }],
    gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
  },
  events: [],
}

const MOCK_DRY_RUN_HIGH_SLIPPAGE = {
  effects: {
    status: { status: 'success' },
    balanceChanges: [
      { owner: { AddressOwner: SENDER }, coinType: '0x2::sui::SUI', amount: '-10000000' },
    ],
    mutated: [],
    gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
  },
  events: [
    {
      type: '0xcetus::pool::SwapEvent',
      parsedJson: {
        amount_in: '10000',
        amount_out: '7000',
        expected_amount_out: '10000',
        // slippage = (10000 - 7000) / 10000 * 10000 = 3000 bps (way above any limit)
      },
    },
  ],
}

const MOCK_DRY_RUN_NEAR_SLIPPAGE = {
  effects: {
    status: { status: 'success' },
    balanceChanges: [],
    mutated: [],
    gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
  },
  events: [
    {
      type: '0xcetus::pool::SwapEvent',
      parsedJson: {
        amount_in: '10000',
        amount_out: '9850',
        expected_amount_out: '10000',
        // slippage = 150 bps; policy limit = 200 bps; warn threshold = 160 bps
        // 150 > 160? No — but 150 > 0.8*200=160? No. Let's use 165
      },
    },
  ],
}

const MOCK_DRY_RUN_WARN_SLIPPAGE = {
  effects: {
    status: { status: 'success' },
    balanceChanges: [],
    mutated: [],
    gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
  },
  events: [
    {
      type: '0xcetus::pool::SwapEvent',
      parsedJson: {
        amount_in: '10000',
        amount_out: '9835',
        expected_amount_out: '10000',
        // slippage = (10000 - 9835) / 10000 * 10000 = 165 bps
        // policy limit = 200 bps; warn threshold = 80% * 200 = 160 bps
        // 160 < 165 <= 200 → WARN
      },
    },
  ],
}

const MOCK_DRY_RUN_NO_EXPECTED = {
  effects: {
    status: { status: 'success' },
    balanceChanges: [],
    mutated: [],
    gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
  },
  events: [
    {
      type: '0xcetus::pool::SwapEvent',
      parsedJson: {
        amount_in: '10000',
        amount_out: '9000',
        // no expected_amount_out
      },
    },
  ],
}

const MOCK_DRY_RUN_BLOCKED_CONTRACT = {
  effects: {
    status: { status: 'success' },
    balanceChanges: [],
    mutated: [],
    gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
  },
  events: [],
}

const MOCK_DRY_RUN_DRAIN = {
  effects: {
    status: { status: 'success' },
    balanceChanges: [
      {
        owner: { AddressOwner: SENDER },
        coinType: '0x2::sui::SUI',
        amount: '-5000000000000', // 5000 SUI outflow — above 1000 SUI threshold
      },
    ],
    mutated: [],
    gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
  },
  events: [],
}

// ---------------------------------------------------------------------------
// SlippageReporter
// ---------------------------------------------------------------------------

describe('SlippageReporter', () => {
  const reporter = new SlippageReporter()

  it('returns PASS when slippage is within limit', () => {
    const policy = makePolicy({ maxSlippageBps: 200 })
    const findings = reporter.analyse(MOCK_DRY_RUN_SAFE, policy)
    expect(findings.filter((f) => f.level === 'BLOCK' || f.level === 'WARN')).toHaveLength(0)
  })

  it('returns WARN when slippage is 80–100% of limit', () => {
    const policy = makePolicy({ maxSlippageBps: 200 }) // warn threshold = 160
    const findings = reporter.analyse(MOCK_DRY_RUN_WARN_SLIPPAGE, policy)
    const warns = findings.filter((f) => f.level === 'WARN' && f.code === 'SLIPPAGE_NEAR_LIMIT')
    expect(warns.length).toBeGreaterThan(0)
  })

  it('returns BLOCK when slippage exceeds limit', () => {
    const policy = makePolicy({ maxSlippageBps: 200 })
    const findings = reporter.analyse(MOCK_DRY_RUN_HIGH_SLIPPAGE, policy)
    const blocks = findings.filter((f) => f.level === 'BLOCK' && f.code === 'SLIPPAGE_EXCEEDED')
    expect(blocks.length).toBeGreaterThan(0)
  })

  it('returns WARN when expected amount is unavailable', () => {
    const policy = makePolicy({ maxSlippageBps: 200 })
    const findings = reporter.analyse(MOCK_DRY_RUN_NO_EXPECTED, policy)
    const warns = findings.filter((f) => f.code === 'EXPECTED_AMOUNT_UNAVAILABLE')
    expect(warns.length).toBeGreaterThan(0)
  })

  it('ignores events that are not swap events', () => {
    const policy = makePolicy({ maxSlippageBps: 200 })
    const dryRun = {
      ...MOCK_DRY_RUN_SAFE,
      events: [{ type: '0x123::pool::LiquidityAdded', parsedJson: {} }],
    }
    const findings = reporter.analyse(dryRun, policy)
    expect(findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// DrainReporter
// ---------------------------------------------------------------------------

describe('DrainReporter', () => {
  it('returns BLOCK when spend exceeds perActionMist', () => {
    const policy = makePolicy({
      spendLimits: { perActionMist: BigInt(1_000_000_000) }, // 1 SUI
    })
    const reporter = new DrainReporter(SENDER)
    // Outflow is 5000 SUI > 1 SUI limit
    const findings = reporter.analyse(MOCK_DRY_RUN_DRAIN, policy)
    const blocks = findings.filter((f) => f.level === 'BLOCK' && f.code === 'SPEND_LIMIT_EXCEEDED')
    expect(blocks.length).toBeGreaterThan(0)
  })

  it('returns WARN when outflow is >80% of balance (large drain)', () => {
    const policy = makePolicy()
    const reporter = new DrainReporter(SENDER)
    const findings = reporter.analyse(MOCK_DRY_RUN_DRAIN, policy)
    const warns = findings.filter((f) => f.level === 'WARN' && f.code === 'LARGE_BALANCE_DRAIN')
    expect(warns.length).toBeGreaterThan(0)
  })

  it('returns PASS on normal transactions', () => {
    const policy = makePolicy({
      spendLimits: { perActionMist: BigInt(10_000_000_000) }, // 10 SUI
    })
    const reporter = new DrainReporter(SENDER)
    const findings = reporter.analyse(MOCK_DRY_RUN_SAFE, policy)
    const blocks = findings.filter((f) => f.level === 'BLOCK')
    expect(blocks).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// ContractReporter
// ---------------------------------------------------------------------------

describe('ContractReporter', () => {
  it('returns BLOCK for blocked package IDs', () => {
    const blockedPkg = '0xbad0'
    const policy = makePolicy({ blockedPackages: [blockedPkg] })
    const reporter = new ContractReporter([`${blockedPkg}::evil::drain`])
    const findings = reporter.analyse(MOCK_DRY_RUN_BLOCKED_CONTRACT, policy)
    const blocks = findings.filter((f) => f.level === 'BLOCK' && f.code === 'BLOCKED_CONTRACT')
    expect(blocks.length).toBeGreaterThan(0)
  })

  it('returns BLOCK for packages not in allowedPackages (when list is non-empty)', () => {
    const policy = makePolicy({ allowedPackages: ['0x1111'] })
    const reporter = new ContractReporter(['0x2222::module::fn'])
    const findings = reporter.analyse(MOCK_DRY_RUN_BLOCKED_CONTRACT, policy)
    const blocks = findings.filter(
      (f) => f.level === 'BLOCK' && f.code === 'UNAUTHORIZED_CONTRACT',
    )
    expect(blocks.length).toBeGreaterThan(0)
  })

  it('returns PASS when allowedPackages is empty', () => {
    const policy = makePolicy({ allowedPackages: [] })
    const reporter = new ContractReporter(['0xanypkg::module::fn'])
    const findings = reporter.analyse(MOCK_DRY_RUN_BLOCKED_CONTRACT, policy)
    const blocks = findings.filter((f) => f.level === 'BLOCK')
    expect(blocks).toHaveLength(0)
  })

  it('returns PASS when package is in allowed list', () => {
    const policy = makePolicy({ allowedPackages: ['0x1111'] })
    const reporter = new ContractReporter(['0x1111::module::fn'])
    const findings = reporter.analyse(MOCK_DRY_RUN_BLOCKED_CONTRACT, policy)
    const blocks = findings.filter((f) => f.level === 'BLOCK')
    expect(blocks).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// PTBVerifier (mocked)
// ---------------------------------------------------------------------------

describe('PTBVerifier', () => {
  function makeMockClient(dryRunResponse: unknown) {
    return {
      dryRunTransactionBlock: vi.fn().mockResolvedValue(dryRunResponse),
    }
  }

  function makeMockPtb(bytes: Uint8Array = new Uint8Array(32)) {
    return {
      build: vi.fn().mockResolvedValue(bytes),
    }
  }

  it('status is BLOCK if any reporter returns BLOCK', async () => {
    const policy = makePolicy({ allowedPackages: ['0x1111'] })

    const mockReporter: Reporter = {
      name: 'MockReporter',
      analyse: () => [{ reporter: 'MockReporter', level: 'BLOCK', code: 'TEST_BLOCK', message: 'blocked' }],
    }

    const client = makeMockClient(MOCK_DRY_RUN_SAFE) as any
    const verifier = new PTBVerifier(client, [mockReporter], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    expect(report.status).toBe('BLOCK')
  })

  it('status is WARN if no BLOCK but some WARN', async () => {
    const policy = makePolicy()

    const mockReporter: Reporter = {
      name: 'MockReporter',
      analyse: () => [{ reporter: 'MockReporter', level: 'WARN', code: 'TEST_WARN', message: 'warn' }],
    }

    const client = makeMockClient(MOCK_DRY_RUN_SAFE) as any
    const verifier = new PTBVerifier(client, [mockReporter], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    expect(report.status).toBe('WARN')
  })

  it('status is PASS when all reporters pass', async () => {
    const policy = makePolicy()

    const mockReporter: Reporter = {
      name: 'MockReporter',
      analyse: () => [],
    }

    const client = makeMockClient(MOCK_DRY_RUN_SAFE) as any
    const verifier = new PTBVerifier(client, [mockReporter], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    expect(report.status).toBe('PASS')
  })

  it('correctly computes netBalanceChangeMist for sender', async () => {
    const policy = makePolicy()
    const client = makeMockClient(MOCK_DRY_RUN_SAFE) as any
    const verifier = new PTBVerifier(client, [], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    expect(report.netBalanceChangeMist).toBe(BigInt(-1_000_000))
  })

  it('correctly computes estimatedGasMist from gas fields', async () => {
    const policy = makePolicy()
    const client = makeMockClient(MOCK_DRY_RUN_SAFE) as any
    const verifier = new PTBVerifier(client, [], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    // computation(1000) + storage(500) - rebate(200) = 1300
    expect(report.estimatedGasMist).toBe(BigInt(1300))
  })

  it('returns BLOCK with DRY_RUN_FAILED when dryRunTransactionBlock throws', async () => {
    const policy = makePolicy()
    const client = {
      dryRunTransactionBlock: vi.fn().mockRejectedValue(new Error('RPC error')),
    } as any
    const verifier = new PTBVerifier(client, [], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    expect(report.status).toBe('BLOCK')
    expect(report.findings[0]?.code).toBe('DRY_RUN_FAILED')
  })

  it('returns BLOCK with DRY_RUN_FAILED when transaction simulation fails', async () => {
    const policy = makePolicy()
    const failedDryRun = {
      effects: {
        status: { status: 'failure', error: 'InsufficientGas' },
      },
    }
    const client = makeMockClient(failedDryRun) as any
    const verifier = new PTBVerifier(client, [], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    expect(report.status).toBe('BLOCK')
    expect(report.findings[0]?.code).toBe('DRY_RUN_FAILED')
  })
})
