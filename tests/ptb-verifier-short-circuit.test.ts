/**
 * PTBVerifier — reporter short-circuit and aggregation behaviour.
 *
 * Kept in a separate file so `vi.mock('../src/verifier/PTBVerifier.js')` used by
 * coverage-gaps.test.ts does not replace the real implementation used here.
 */

import { describe, it, expect, vi } from 'vitest'
import { PTBVerifier } from '../src/verifier/PTBVerifier.js'
import { SessionPolicySchema } from '../src/session/types.js'
import type { SessionPolicy } from '../src/session/types.js'
import type { Reporter } from '../src/verifier/types.js'

function makePolicy(overrides: Partial<SessionPolicy> = {}): SessionPolicy {
  return SessionPolicySchema.parse({ id: 'test', name: 'Test', ...overrides })
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

function makeMockClient(dryRunResponse: unknown) {
  return {
    dryRunTransactionBlock: vi.fn().mockResolvedValue(dryRunResponse),
  }
}

function makeMockPtb(bytes: Uint8Array = new Uint8Array(32)) {
  return { build: vi.fn().mockResolvedValue(bytes) }
}

describe('PTBVerifier — reporter short-circuit', () => {
  it('stops calling reporters after ContractReporter returns BLOCK', async () => {
    const policy = makePolicy()

    const contractReporter: Reporter = {
      name: 'ContractReporter',
      analyse: vi.fn().mockReturnValue([
        { reporter: 'ContractReporter', level: 'BLOCK', code: 'BLOCKED_CONTRACT', message: 'blocked' },
      ]),
    }
    const drainReporter: Reporter = {
      name: 'DrainReporter',
      analyse: vi.fn().mockReturnValue([]),
    }

    const client = makeMockClient(EMPTY_EFFECTS) as any
    const verifier = new PTBVerifier(client, [contractReporter, drainReporter], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    expect(report.status).toBe('BLOCK')
    expect(contractReporter.analyse).toHaveBeenCalledOnce()
    expect(drainReporter.analyse).not.toHaveBeenCalled()
  })

  it('does NOT short-circuit when a non-ContractReporter returns BLOCK', async () => {
    const policy = makePolicy()

    const firstReporter: Reporter = {
      name: 'DrainReporter',
      analyse: vi.fn().mockReturnValue([
        { reporter: 'DrainReporter', level: 'BLOCK', code: 'SPEND_LIMIT_EXCEEDED', message: 'block' },
      ]),
    }
    const secondReporter: Reporter = {
      name: 'SlippageReporter',
      analyse: vi.fn().mockReturnValue([]),
    }

    const client = makeMockClient(EMPTY_EFFECTS) as any
    const verifier = new PTBVerifier(client, [firstReporter, secondReporter], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    expect(report.status).toBe('BLOCK')
    // Both reporters should be called — short-circuit only applies to ContractReporter
    expect(firstReporter.analyse).toHaveBeenCalledOnce()
    expect(secondReporter.analyse).toHaveBeenCalledOnce()
  })

  it('aggregates findings from multiple reporters when no BLOCK', async () => {
    const policy = makePolicy()

    const r1: Reporter = {
      name: 'R1',
      analyse: vi.fn().mockReturnValue([
        { reporter: 'R1', level: 'WARN', code: 'W1', message: 'warn 1' },
      ]),
    }
    const r2: Reporter = {
      name: 'R2',
      analyse: vi.fn().mockReturnValue([
        { reporter: 'R2', level: 'WARN', code: 'W2', message: 'warn 2' },
      ]),
    }

    const client = makeMockClient(EMPTY_EFFECTS) as any
    const verifier = new PTBVerifier(client, [r1, r2], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    expect(report.status).toBe('WARN')
    expect(report.findings).toHaveLength(2)
  })

  it('ContractReporter BLOCK does not affect status if short-circuited via hasBlock flag', async () => {
    // Verify that hasBlock=true path produces BLOCK even when aggregateRiskLevel would say PASS
    const policy = makePolicy()

    const contractReporter: Reporter = {
      name: 'ContractReporter',
      analyse: vi.fn().mockReturnValue([
        { reporter: 'ContractReporter', level: 'BLOCK', code: 'BLOCKED_CONTRACT', message: 'blocked' },
      ]),
    }

    const client = makeMockClient(EMPTY_EFFECTS) as any
    const verifier = new PTBVerifier(client, [contractReporter], policy)
    const report = await verifier.verify(makeMockPtb() as any, SENDER)

    expect(report.status).toBe('BLOCK')
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.code).toBe('BLOCKED_CONTRACT')
  })
})
