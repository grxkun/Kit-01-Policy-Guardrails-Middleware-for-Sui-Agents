import type { SessionPolicy, SessionKeyRecord, SpendLogEntry } from './types.js'
import type { AgentAction } from '../middleware/types.js'

export interface PolicyViolation {
  rule: string
  detail: string
}

export class PolicyEngine {
  constructor(private policy: SessionPolicy) {}

  /**
   * Validate an action against all policy rules.
   * Returns an array of violations (empty = allowed).
   */
  validateAction(action: AgentAction): PolicyViolation[] {
    const violations: PolicyViolation[] = []

    // Check session is still alive if a record is attached
    // (session aliveness is checked separately via isAlive)

    // Check spend limit per action
    if (action.estimatedSpendMist !== undefined) {
      const spendViolation = this.validateSpend(action.estimatedSpendMist, [])
      if (spendViolation) violations.push(spendViolation)
    }

    return violations
  }

  /**
   * Validate a specific package::module::function call target.
   * Returns a PolicyViolation if blocked, null if allowed.
   */
  validateCall(target: string): PolicyViolation | null {
    const packageId = extractPackageId(target)

    // Always block packages in the blocklist
    if (this.policy.blockedPackages.length > 0) {
      for (const blocked of this.policy.blockedPackages) {
        if (normaliseAddress(packageId) === normaliseAddress(blocked)) {
          return {
            rule: 'blockedPackages',
            detail: `Package ${packageId} is explicitly blocked`,
          }
        }
      }
    }

    // If allowedPackages is non-empty, only allow listed packages
    if (this.policy.allowedPackages.length > 0) {
      const allowed = this.policy.allowedPackages.some(
        (p) => normaliseAddress(packageId) === normaliseAddress(p),
      )
      if (!allowed) {
        return {
          rule: 'allowedPackages',
          detail: `Package ${packageId} is not in the allowed packages list`,
        }
      }
    }

    // If allowedFunctions is non-empty, only allow listed functions
    if (this.policy.allowedFunctions.length > 0) {
      const allowed = this.policy.allowedFunctions.some(
        (f) => normaliseAddress(f) === normaliseAddress(target),
      )
      if (!allowed) {
        return {
          rule: 'allowedFunctions',
          detail: `Function ${target} is not in the allowed functions list`,
        }
      }
    }

    return null
  }

  /**
   * Check if the rolling spend limit allows this action.
   * Returns a PolicyViolation if exceeded, null if allowed.
   */
  validateSpend(amountMist: bigint, spendLog: SpendLogEntry[]): PolicyViolation | null {
    const limits = this.policy.spendLimits
    if (!limits) return null

    // Per-action limit check
    if (limits.perActionMist !== undefined && amountMist > limits.perActionMist) {
      return {
        rule: 'spendLimits.perActionMist',
        detail: `Action spend ${amountMist} MIST exceeds per-action limit of ${limits.perActionMist} MIST`,
      }
    }

    // Rolling window check
    if (limits.rollingWindowMist !== undefined) {
      const windowMs = limits.rollingWindowMs ?? 3_600_000
      const now = Date.now()
      const windowStart = now - windowMs

      const windowTotal = spendLog
        .filter((e) => e.timestamp >= windowStart)
        .reduce((sum, e) => sum + e.amountMist, BigInt(0))

      if (windowTotal + amountMist > limits.rollingWindowMist) {
        return {
          rule: 'spendLimits.rollingWindowMist',
          detail: `Rolling window spend ${windowTotal + amountMist} MIST exceeds limit of ${limits.rollingWindowMist} MIST`,
        }
      }
    }

    return null
  }

  /**
   * Returns true if the session is within its TTL.
   */
  isAlive(session: SessionKeyRecord): boolean {
    return session.expiresAt > Date.now()
  }
}

/**
 * Extract the package ID from a fully-qualified Move target "0xPKG::module::fn".
 */
function extractPackageId(target: string): string {
  return target.split('::')[0] ?? target
}

/**
 * Normalise a Sui address or package ID for comparison.
 * Strips leading zeros after 0x prefix to a consistent form.
 */
function normaliseAddress(addr: string): string {
  if (!addr.startsWith('0x') && !addr.startsWith('0X')) return addr.toLowerCase()
  const hex = addr.slice(2).replace(/^0+/, '') || '0'
  return '0x' + hex.toLowerCase()
}
