import type { Reporter, RiskFinding } from '../types.js'
import type { SessionPolicy } from '../../session/types.js'

const SUI_TYPE = '0x2::sui::SUI'

/**
 * Detects wallet-draining patterns in transaction balance changes.
 */
export class DrainReporter implements Reporter {
  readonly name = 'DrainReporter'

  constructor(
    private sender: string,
    /** Known protocol addresses (e.g. AMM pools) that may receive funds */
    private knownProtocolAddresses: string[] = [],
  ) {}

  analyse(dryRun: unknown, policy: SessionPolicy): RiskFinding[] {
    const findings: RiskFinding[] = []
    const dryRunData = dryRun as Record<string, unknown>
    const effects = dryRunData?.effects as Record<string, unknown> | undefined

    const balanceChanges = (effects?.balanceChanges ?? dryRunData?.balanceChanges) as
      | BalanceChange[]
      | undefined

    const mutatedObjects = extractMutatedObjectIds(effects)

    if (!balanceChanges) return findings

    // Analyse SUI outflow for sender
    for (const change of balanceChanges) {
      if (normaliseAddress(change.owner?.AddressOwner ?? '') !== normaliseAddress(this.sender)) {
        continue
      }

      const amount = parseBigInt(change.amount)
      if (amount === null || amount >= BigInt(0)) continue // Not an outflow

      const outflow = -amount // positive number representing outflow

      // Check per-action spend limit
      if (
        change.coinType === SUI_TYPE &&
        policy.spendLimits?.perActionMist !== undefined &&
        outflow > policy.spendLimits.perActionMist
      ) {
        findings.push({
          reporter: this.name,
          level: 'BLOCK',
          code: 'SPEND_LIMIT_EXCEEDED',
          message: `SUI outflow ${outflow} MIST exceeds per-action limit of ${policy.spendLimits.perActionMist} MIST`,
          evidence: { coinType: change.coinType, outflow: outflow.toString(), limit: policy.spendLimits.perActionMist.toString() },
        })
      }
    }

    // Check for large balance drain (>80% of estimated balance)
    // We look at all coin types for sender
    const senderChanges = balanceChanges.filter(
      (c) => normaliseAddress(c.owner?.AddressOwner ?? '') === normaliseAddress(this.sender),
    )

    for (const change of senderChanges) {
      const amount = parseBigInt(change.amount)
      if (amount === null || amount >= BigInt(0)) continue

      const outflow = -amount
      // We don't have the actual balance, but if the change is extremely large,
      // we emit a warning. Use a threshold of 80% drain detection:
      // Since we don't have the actual balance from dry-run alone, we check
      // if a "currentBalance" hint is provided in evidence or we skip.
      // In practice, callers can pass balance hints; here we emit WARN if outflow > 1000 SUI
      // as a conservative heuristic when no balance data is available.
      const threshold = BigInt(1_000_000_000_000) // 1000 SUI in MIST
      if (outflow > threshold) {
        findings.push({
          reporter: this.name,
          level: 'WARN',
          code: 'LARGE_BALANCE_DRAIN',
          message: `Large outflow detected: ${outflow} MIST of ${change.coinType} leaving sender`,
          evidence: { coinType: change.coinType, outflow: outflow.toString() },
        })
      }
    }

    // Check for unexpected object mutations (objects not owned by sender or known protocol)
    const knownAddresses = new Set([
      normaliseAddress(this.sender),
      ...this.knownProtocolAddresses.map(normaliseAddress),
    ])

    // TODO(v0.2): Cross-reference mutated object ownership against sender and known protocol
    // addresses using object ownership data from the full node. This requires an additional
    // RPC call (suix_getObject) for each mutated object and is deferred to the next version.
    void mutatedObjects
    void knownAddresses

    return findings
  }
}

interface BalanceChange {
  owner: { AddressOwner?: string; ObjectOwner?: string }
  coinType: string
  amount: string | number | bigint
}

function extractMutatedObjectIds(effects: Record<string, unknown> | undefined): string[] {
  if (!effects) return []
  const mutated = effects.mutated as Array<{ reference?: { objectId?: string } }> | undefined
  if (!mutated) return []
  return mutated.map((m) => m.reference?.objectId ?? '').filter(Boolean)
}

function parseBigInt(value: unknown): bigint | null {
  if (value === undefined || value === null) return null
  try {
    return BigInt(String(value))
  } catch {
    return null
  }
}

function normaliseAddress(addr: string): string {
  if (!addr) return ''
  if (!addr.startsWith('0x') && !addr.startsWith('0X')) return addr.toLowerCase()
  const hex = addr.slice(2).replace(/^0+/, '') || '0'
  return '0x' + hex.toLowerCase()
}
