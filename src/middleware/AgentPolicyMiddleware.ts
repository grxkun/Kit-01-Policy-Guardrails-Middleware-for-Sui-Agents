import { SuiClient } from '@mysten/sui/client'
import { SessionPolicySchema } from '../session/types.js'
import { SessionKey } from '../session/SessionKey.js'
import { PolicyEngine } from '../session/SessionPolicy.js'
import { PTBVerifier } from '../verifier/PTBVerifier.js'
import { ContractReporter } from '../verifier/reporters/ContractReporter.js'
import { DrainReporter } from '../verifier/reporters/DrainReporter.js'
import { SlippageReporter } from '../verifier/reporters/SlippageReporter.js'
import type { Reporter, RiskReport } from '../verifier/types.js'
import type { SessionKeyRecord, SessionPolicy } from '../session/types.js'
import type { AgentAction, PolicyMiddlewareOptions, ActionExecutor } from './types.js'

export class PolicyBlockedError extends Error {
  constructor(
    public readonly report: RiskReport,
    public readonly action: AgentAction,
  ) {
    super(
      `Action "${action.label}" blocked: ${report.findings
        .filter((f) => f.level === 'BLOCK')
        .map((f) => f.message)
        .join('; ')}`,
    )
    this.name = 'PolicyBlockedError'
  }
}

/**
 * Build the default reporter chain for a policy + sender.
 * Order: ContractReporter (fast) → DrainReporter → SlippageReporter (most expensive).
 */
function defaultReporters(agentAddress: string): Reporter[] {
  return [
    new ContractReporter([]),
    new DrainReporter(agentAddress),
    new SlippageReporter(),
  ]
}

/**
 * Create a policy middleware instance that wraps any agent action dispatcher
 * with session-scoped authority enforcement and PTB pre-flight risk verification.
 */
export function createPolicyMiddleware(options: PolicyMiddlewareOptions) {
  // Validate policy at creation time — throw immediately on invalid input
  const policy = SessionPolicySchema.parse(options.policy)
  const { rpcUrl, agentAddress } = options

  const client = new SuiClient({ url: rpcUrl })
  const sessionKey = SessionKey.generate(policy)
  const engine = new PolicyEngine(policy)
  const verifier = new PTBVerifier(client, defaultReporters(agentAddress), policy)

  return {
    sessionKey,

    /**
     * Wraps an action executor with policy + PTB verification.
     * Returns the tx digest on success.
     * Throws PolicyBlockedError on violation or if risk is BLOCK.
     */
    async execute(action: AgentAction, executor: ActionExecutor): Promise<string> {
      // 1. Validate session is alive
      const record = sessionKey.getRecord()
      if (!engine.isAlive(record)) {
        throw new PolicyBlockedError(
          {
            status: 'BLOCK',
            findings: [
              {
                reporter: 'SessionPolicy',
                level: 'BLOCK',
                code: 'SESSION_EXPIRED',
                message: 'Session key has expired',
              },
            ],
            estimatedGasMist: BigInt(0),
            netBalanceChangeMist: BigInt(0),
            mutatedObjects: [],
            rawDryRun: null,
            generatedAt: Date.now(),
          },
          action,
        )
      }

      // 2. Validate action against policy rules
      const violations = engine.validateAction(action)
      if (violations.length > 0) {
        const report: RiskReport = {
          status: 'BLOCK',
          findings: violations.map((v) => ({
            reporter: 'PolicyEngine',
            level: 'BLOCK' as const,
            code: v.rule.toUpperCase().replace(/\./g, '_'),
            message: v.detail,
          })),
          estimatedGasMist: BigInt(0),
          netBalanceChangeMist: BigInt(0),
          mutatedObjects: [],
          rawDryRun: null,
          generatedAt: Date.now(),
        }
        options.onBlocked?.(report, action)
        throw new PolicyBlockedError(report, action)
      }

      // 3. Run PTB verifier (dry-run + reporters)
      const report = await verifier.verify(action.ptb, agentAddress)

      // 4. Call onRiskReport hook — allow caller to abort
      if (options.onRiskReport) {
        const proceed = await options.onRiskReport(report, action)
        if (!proceed) {
          options.onBlocked?.(report, action)
          throw new PolicyBlockedError(report, action)
        }
      }

      // 5. Check risk level
      const isBlocked =
        report.status === 'BLOCK' ||
        (report.status === 'WARN' && !policy.allowWarn)

      if (isBlocked) {
        options.onBlocked?.(report, action)
        throw new PolicyBlockedError(report, action)
      }

      // 6. Execute
      const txDigest = await executor(action)

      // 7. Log spend
      sessionKey.addSpendLog({
        timestamp: Date.now(),
        actionId: action.id,
        amountMist: action.estimatedSpendMist ?? BigInt(0),
        txDigest,
      })

      options.onExecuted?.(txDigest, action)
      return txDigest
    },

    /**
     * Current session info without the private key.
     */
    getSessionInfo(): Omit<SessionKeyRecord, 'privateKey'> {
      return sessionKey.getSafeRecord()
    },

    /**
     * Revoke the session key immediately.
     */
    revoke(): void {
      sessionKey.revoke()
    },
  }
}
