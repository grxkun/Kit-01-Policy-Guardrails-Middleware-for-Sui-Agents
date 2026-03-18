import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPolicyMiddleware, PolicyBlockedError } from '../src/middleware/AgentPolicyMiddleware.js'
import { SessionPolicySchema } from '../src/session/types.js'
import { Transaction } from '@mysten/sui/transactions'
import type { SessionPolicy } from '../src/session/types.js'
import type { AgentAction } from '../src/middleware/types.js'
import type { RiskReport } from '../src/verifier/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<SessionPolicy> = {}): SessionPolicy {
  return SessionPolicySchema.parse({
    id: 'test',
    name: 'Test',
    ...overrides,
  })
}

function makePtb(): Transaction {
  return new Transaction()
}

function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: 'action-001',
    label: 'Test Action',
    ptb: makePtb(),
    estimatedSpendMist: BigInt(1_000_000),
    ...overrides,
  }
}

function makePassReport(): RiskReport {
  return {
    status: 'PASS',
    findings: [],
    estimatedGasMist: BigInt(1000),
    netBalanceChangeMist: BigInt(-1_000_000),
    mutatedObjects: [],
    rawDryRun: {},
    generatedAt: Date.now(),
  }
}

function makeWarnReport(): RiskReport {
  return {
    ...makePassReport(),
    status: 'WARN',
    findings: [{ reporter: 'Mock', level: 'WARN', code: 'MOCK_WARN', message: 'warning' }],
  }
}

function makeBlockReport(): RiskReport {
  return {
    ...makePassReport(),
    status: 'BLOCK',
    findings: [{ reporter: 'Mock', level: 'BLOCK', code: 'MOCK_BLOCK', message: 'blocked action' }],
  }
}

// Mock PTBVerifier to avoid real RPC calls
vi.mock('../src/verifier/PTBVerifier.js', () => {
  return {
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
  }
})

// Mock SuiClient to avoid real network calls
vi.mock('@mysten/sui/client', () => {
  return {
    SuiClient: vi.fn().mockImplementation(() => ({})),
  }
})

// ---------------------------------------------------------------------------
// Helper to get the mocked verifier instance
// ---------------------------------------------------------------------------

async function createMiddlewareWithVerifyFn(
  verifyFn: () => Promise<RiskReport>,
  policyOverrides: Partial<SessionPolicy> = {},
) {
  const { PTBVerifier } = await import('../src/verifier/PTBVerifier.js')
  const mockVerifier = {
    verify: vi.fn().mockImplementation(verifyFn),
  }
  ;(PTBVerifier as ReturnType<typeof vi.fn>).mockImplementation(() => mockVerifier)

  const policy = makePolicy(policyOverrides)

  const onRiskReport = vi.fn().mockReturnValue(true)
  const onExecuted = vi.fn()
  const onBlocked = vi.fn()

  const middleware = createPolicyMiddleware({
    policy,
    rpcUrl: 'https://fullnode.mainnet.sui.io',
    agentAddress: '0xagent',
    onRiskReport,
    onExecuted,
    onBlocked,
  })

  return { middleware, onRiskReport, onExecuted, onBlocked, mockVerifier }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentPolicyMiddleware', () => {
  it('executes action when risk is PASS', async () => {
    const { middleware, onExecuted } = await createMiddlewareWithVerifyFn(() =>
      Promise.resolve(makePassReport()),
    )

    const executor = vi.fn().mockResolvedValue('digest-pass')
    const txDigest = await middleware.execute(makeAction(), executor)

    expect(txDigest).toBe('digest-pass')
    expect(executor).toHaveBeenCalledOnce()
    expect(onExecuted).toHaveBeenCalledWith('digest-pass', expect.objectContaining({ id: 'action-001' }))
  })

  it('executes action when risk is WARN and allowWarn is true', async () => {
    const { middleware, onExecuted } = await createMiddlewareWithVerifyFn(
      () => Promise.resolve(makeWarnReport()),
      { allowWarn: true },
    )

    const executor = vi.fn().mockResolvedValue('digest-warn')
    const txDigest = await middleware.execute(makeAction(), executor)

    expect(txDigest).toBe('digest-warn')
    expect(onExecuted).toHaveBeenCalled()
  })

  it('throws PolicyBlockedError when risk is BLOCK', async () => {
    const { middleware, onBlocked } = await createMiddlewareWithVerifyFn(() =>
      Promise.resolve(makeBlockReport()),
    )

    const executor = vi.fn().mockResolvedValue('digest-block')

    await expect(middleware.execute(makeAction(), executor)).rejects.toThrow(PolicyBlockedError)
    expect(executor).not.toHaveBeenCalled()
    expect(onBlocked).toHaveBeenCalled()
  })

  it('throws PolicyBlockedError when risk is WARN and allowWarn is false', async () => {
    const { middleware, onBlocked } = await createMiddlewareWithVerifyFn(
      () => Promise.resolve(makeWarnReport()),
      { allowWarn: false },
    )

    const executor = vi.fn()
    await expect(middleware.execute(makeAction(), executor)).rejects.toThrow(PolicyBlockedError)
    expect(executor).not.toHaveBeenCalled()
    expect(onBlocked).toHaveBeenCalled()
  })

  it('calls onRiskReport before execution', async () => {
    const { middleware, onRiskReport } = await createMiddlewareWithVerifyFn(() =>
      Promise.resolve(makePassReport()),
    )

    const executor = vi.fn().mockResolvedValue('digest')
    await middleware.execute(makeAction(), executor)

    expect(onRiskReport).toHaveBeenCalledOnce()
    expect(onRiskReport).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PASS' }),
      expect.objectContaining({ id: 'action-001' }),
    )
  })

  it('aborts if onRiskReport returns false', async () => {
    const { PTBVerifier } = await import('../src/verifier/PTBVerifier.js')
    const mockVerifier = {
      verify: vi.fn().mockResolvedValue(makePassReport()),
    }
    ;(PTBVerifier as ReturnType<typeof vi.fn>).mockImplementation(() => mockVerifier)

    const onBlocked = vi.fn()
    const middleware = createPolicyMiddleware({
      policy: makePolicy(),
      rpcUrl: 'https://fullnode.mainnet.sui.io',
      agentAddress: '0xagent',
      onRiskReport: () => false,
      onBlocked,
    })

    const executor = vi.fn()
    await expect(middleware.execute(makeAction(), executor)).rejects.toThrow(PolicyBlockedError)
    expect(executor).not.toHaveBeenCalled()
    expect(onBlocked).toHaveBeenCalled()
  })

  it('calls onBlocked when action is blocked', async () => {
    const { middleware, onBlocked } = await createMiddlewareWithVerifyFn(() =>
      Promise.resolve(makeBlockReport()),
    )

    const executor = vi.fn()
    await expect(middleware.execute(makeAction(), executor)).rejects.toThrow(PolicyBlockedError)
    expect(onBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'BLOCK' }),
      expect.objectContaining({ id: 'action-001' }),
    )
  })

  it('calls onExecuted with txDigest after success', async () => {
    const { middleware, onExecuted } = await createMiddlewareWithVerifyFn(() =>
      Promise.resolve(makePassReport()),
    )

    const executor = vi.fn().mockResolvedValue('0xdigest123')
    await middleware.execute(makeAction(), executor)

    expect(onExecuted).toHaveBeenCalledWith('0xdigest123', expect.objectContaining({ id: 'action-001' }))
  })

  it('exposes session info without private key', () => {
    const policy = makePolicy()
    const middleware = createPolicyMiddleware({
      policy,
      rpcUrl: 'https://fullnode.mainnet.sui.io',
      agentAddress: '0xagent',
    })

    const sessionInfo = middleware.getSessionInfo()
    expect('privateKey' in sessionInfo).toBe(false)
    expect(sessionInfo.publicKey).toBeTruthy()
    expect(sessionInfo.policy.id).toBe('test')
  })

  it('throws PolicyBlockedError with correct message', async () => {
    const { middleware } = await createMiddlewareWithVerifyFn(() =>
      Promise.resolve(makeBlockReport()),
    )

    const executor = vi.fn()
    const error = await middleware.execute(makeAction(), executor).catch((e) => e)

    expect(error).toBeInstanceOf(PolicyBlockedError)
    expect(error.message).toContain('Test Action')
    expect(error.message).toContain('blocked action')
    expect(error.report.status).toBe('BLOCK')
    expect(error.action.id).toBe('action-001')
  })

  it('revoke() disables the session key', async () => {
    const { PTBVerifier } = await import('../src/verifier/PTBVerifier.js')
    ;(PTBVerifier as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      verify: vi.fn().mockResolvedValue(makePassReport()),
    }))

    const policy = makePolicy()
    const middleware = createPolicyMiddleware({
      policy,
      rpcUrl: 'https://fullnode.mainnet.sui.io',
      agentAddress: '0xagent',
    })

    middleware.revoke()
    expect(middleware.sessionKey.isValid()).toBe(false)
  })

  it('throws immediately when policy is invalid', () => {
    expect(() =>
      createPolicyMiddleware({
        policy: { id: '', name: '' } as any,
        rpcUrl: 'https://fullnode.mainnet.sui.io',
        agentAddress: '0xagent',
      }),
    ).toThrow()
  })
})
