import { SuiClient } from '@mysten/sui/client'
import type { Transaction } from '@mysten/sui/transactions'
import type { Reporter, RiskReport } from './types.js'
import type { SessionPolicy } from '../session/types.js'
import {
  aggregateRiskLevel,
  extractNetBalanceChange,
  extractEstimatedGas,
  extractMutatedObjects,
  buildDryRunFailedReport,
} from './RiskAnalyser.js'

export class PTBVerifier {
  constructor(
    private client: SuiClient,
    private reporters: Reporter[],
    private policy: SessionPolicy,
  ) {}

  /**
   * Dry-run the PTB and run all reporters. Returns a RiskReport.
   */
  async verify(ptb: Transaction, sender: string): Promise<RiskReport> {
    let dryRunResponse: unknown

    try {
      const bytes = await ptb.build({ client: this.client })
      dryRunResponse = await this.client.dryRunTransactionBlock({
        transactionBlock: bytes,
      })
    } catch (err) {
      return buildDryRunFailedReport(err)
    }

    const dryRunData = dryRunResponse as Record<string, unknown>
    const effects = dryRunData?.effects as Record<string, unknown> | undefined

    // Check if the dry-run itself reported failure
    const statusObj = effects?.status as Record<string, unknown> | undefined
    if (statusObj?.status === 'failure') {
      return buildDryRunFailedReport(
        `Transaction simulation failed: ${statusObj?.error ?? 'unknown error'}`,
      )
    }

    const netBalanceChangeMist = extractNetBalanceChange(effects, sender)
    const estimatedGasMist = extractEstimatedGas(effects)
    const mutatedObjects = extractMutatedObjects(effects)

    // Run all reporters (ContractReporter first, then DrainReporter, then SlippageReporter)
    const allFindings = []
    let hasBlock = false

    for (const reporter of this.reporters) {
      const findings = reporter.analyse(dryRunResponse, this.policy)
      allFindings.push(...findings)

      // Short-circuit after ContractReporter if it returns a BLOCK
      if (reporter.name === 'ContractReporter' && findings.some((f) => f.level === 'BLOCK')) {
        hasBlock = true
        break
      }
    }

    const status = hasBlock ? 'BLOCK' : aggregateRiskLevel(allFindings)

    return {
      status,
      findings: allFindings,
      estimatedGasMist,
      netBalanceChangeMist,
      mutatedObjects,
      rawDryRun: dryRunResponse,
      generatedAt: Date.now(),
    }
  }
}
