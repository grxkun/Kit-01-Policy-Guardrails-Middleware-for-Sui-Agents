import type { Reporter, RiskFinding } from '../types.js'
import type { SessionPolicy } from '../../session/types.js'

/**
 * Checks all Move call targets in the PTB against the policy's
 * allowed/blocked package lists.
 */
export class ContractReporter implements Reporter {
  readonly name = 'ContractReporter'

  constructor(
    /** The PTB transactions array extracted from the transaction data */
    private ptbTransactions: unknown[] = [],
  ) {}

  analyse(dryRun: unknown, policy: SessionPolicy): RiskFinding[] {
    const findings: RiskFinding[] = []
    const dryRunData = dryRun as Record<string, unknown>

    // Extract move call targets from PTB transactions
    const targets = extractMoveCallTargets(this.ptbTransactions)

    // Also extract from the input objects in the dry run response
    const txData = dryRunData?.transaction as Record<string, unknown> | undefined
    const txDataInner = txData?.data as Record<string, unknown> | undefined
    const txDataTransactions = (txDataInner?.transaction as Record<string, unknown> | undefined)?.transactions as unknown[] | undefined

    if (txDataTransactions) {
      targets.push(...extractMoveCallTargets(txDataTransactions))
    }

    const encounteredPackages = new Set<string>()

    for (const target of targets) {
      const packageId = extractPackageId(target)
      encounteredPackages.add(packageId)

      // Check blocklist
      for (const blocked of policy.blockedPackages) {
        if (normaliseAddress(packageId) === normaliseAddress(blocked)) {
          findings.push({
            reporter: this.name,
            level: 'BLOCK',
            code: 'BLOCKED_CONTRACT',
            message: `Package ${packageId} is explicitly blocked by policy`,
            evidence: { target, packageId, blockedPackages: policy.blockedPackages },
          })
        }
      }

      // Check allowlist (only if non-empty)
      if (policy.allowedPackages.length > 0) {
        const allowed = policy.allowedPackages.some(
          (p) => normaliseAddress(packageId) === normaliseAddress(p),
        )
        if (!allowed) {
          findings.push({
            reporter: this.name,
            level: 'BLOCK',
            code: 'UNAUTHORIZED_CONTRACT',
            message: `Package ${packageId} is not in the allowed packages list`,
            evidence: { target, packageId, allowedPackages: policy.allowedPackages },
          })
        }
      }
    }

    // Log all unique packages as evidence in an info-level finding if there are no issues
    if (findings.length === 0 && encounteredPackages.size > 0) {
      // No violations — no findings needed
    }

    return findings
  }
}

function extractMoveCallTargets(transactions: unknown[]): string[] {
  const targets: string[] = []
  for (const tx of transactions) {
    // Handle plain string targets
    if (typeof tx === 'string') {
      targets.push(tx)
      continue
    }
    const txObj = tx as Record<string, unknown>
    // Format: { MoveCall: { package, module, function } }
    const moveCall = txObj?.MoveCall as Record<string, unknown> | undefined
    if (moveCall) {
      const pkg = moveCall.package as string | undefined
      const mod = moveCall.module as string | undefined
      const fn = moveCall.function as string | undefined
      if (pkg && mod && fn) {
        targets.push(`${pkg}::${mod}::${fn}`)
      } else if (pkg) {
        targets.push(pkg)
      }
    }
    // Also check for direct target string
    const target = txObj?.target as string | undefined
    if (target) {
      targets.push(target)
    }
  }
  return targets
}

function extractPackageId(target: string): string {
  return target.split('::')[0] ?? target
}

function normaliseAddress(addr: string): string {
  if (!addr.startsWith('0x') && !addr.startsWith('0X')) return addr.toLowerCase()
  const hex = addr.slice(2).replace(/^0+/, '') || '0'
  return '0x' + hex.toLowerCase()
}
