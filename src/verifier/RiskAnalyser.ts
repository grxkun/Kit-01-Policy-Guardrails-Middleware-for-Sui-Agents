import type { RiskLevel, RiskFinding, RiskReport } from './types.js'

const LEVEL_ORDER: Record<RiskLevel, number> = {
  PASS: 0,
  WARN: 1,
  BLOCK: 2,
}

/**
 * Determines the aggregate risk status from an array of findings.
 */
export function aggregateRiskLevel(findings: RiskFinding[]): RiskLevel {
  let max: RiskLevel = 'PASS'
  for (const finding of findings) {
    if (LEVEL_ORDER[finding.level] > LEVEL_ORDER[max]) {
      max = finding.level
    }
  }
  return max
}

/**
 * Extract net balance change in MIST for a given sender address from dry-run effects.
 */
export function extractNetBalanceChange(
  effects: Record<string, unknown> | undefined,
  sender: string,
): bigint {
  if (!effects) return BigInt(0)
  const balanceChanges = (effects.balanceChanges ?? []) as Array<{
    owner: { AddressOwner?: string }
    coinType: string
    amount: string
  }>

  const SUI_TYPE = '0x2::sui::SUI'
  let net = BigInt(0)
  const normSender = normaliseAddress(sender)

  for (const change of balanceChanges) {
    if (normaliseAddress(change.owner?.AddressOwner ?? '') !== normSender) continue
    if (change.coinType !== SUI_TYPE) continue
    try {
      net += BigInt(change.amount)
    } catch {
      // skip unparseable
    }
  }
  return net
}

/**
 * Extract estimated gas cost in MIST from dry-run gas used fields.
 */
export function extractEstimatedGas(
  effects: Record<string, unknown> | undefined,
): bigint {
  if (!effects) return BigInt(0)
  const gasUsed = effects.gasUsed as
    | { computationCost: string; storageCost: string; storageRebate: string }
    | undefined

  if (!gasUsed) return BigInt(0)

  try {
    const computation = BigInt(gasUsed.computationCost ?? '0')
    const storage = BigInt(gasUsed.storageCost ?? '0')
    const rebate = BigInt(gasUsed.storageRebate ?? '0')
    return computation + storage - rebate
  } catch {
    return BigInt(0)
  }
}

/**
 * Extract mutated object IDs from effects.
 */
export function extractMutatedObjects(
  effects: Record<string, unknown> | undefined,
): string[] {
  if (!effects) return []
  const mutated = effects.mutated as Array<{ reference?: { objectId?: string } }> | undefined
  if (!mutated) return []
  return mutated.map((m) => m.reference?.objectId ?? '').filter(Boolean)
}

/**
 * Build a BLOCK RiskReport for dry-run failures.
 */
export function buildDryRunFailedReport(error: unknown): RiskReport {
  return {
    status: 'BLOCK',
    findings: [
      {
        reporter: 'PTBVerifier',
        level: 'BLOCK',
        code: 'DRY_RUN_FAILED',
        message: `Dry-run failed: ${error instanceof Error ? error.message : String(error)}`,
        evidence: { error: String(error) },
      },
    ],
    estimatedGasMist: BigInt(0),
    netBalanceChangeMist: BigInt(0),
    mutatedObjects: [],
    rawDryRun: null,
    generatedAt: Date.now(),
  }
}

function normaliseAddress(addr: string): string {
  if (!addr) return ''
  if (!addr.startsWith('0x') && !addr.startsWith('0X')) return addr.toLowerCase()
  const hex = addr.slice(2).replace(/^0+/, '') || '0'
  return '0x' + hex.toLowerCase()
}
