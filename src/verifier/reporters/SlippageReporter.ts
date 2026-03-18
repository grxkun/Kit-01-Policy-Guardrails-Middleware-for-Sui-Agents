import type { Reporter, RiskFinding } from '../types.js'
import type { SessionPolicy } from '../../session/types.js'

/**
 * Detects slippage risk in swap transactions by parsing swap events.
 */
export class SlippageReporter implements Reporter {
  readonly name = 'SlippageReporter'

  analyse(dryRun: unknown, policy: SessionPolicy): RiskFinding[] {
    const findings: RiskFinding[] = []
    const dryRunData = dryRun as Record<string, unknown>
    const events = (dryRunData?.events as unknown[]) ?? []

    for (const event of events) {
      const ev = event as Record<string, unknown>
      const eventType = (ev?.type as string) ?? ''

      // Look for swap events
      if (!eventType.toLowerCase().includes('swap')) continue

      const parsedJson = ev?.parsedJson as Record<string, unknown> | undefined

      if (!parsedJson) continue

      const amountIn = parseBigInt(parsedJson?.amount_in ?? parsedJson?.amountIn)
      const amountOut = parseBigInt(parsedJson?.amount_out ?? parsedJson?.amountOut)
      const expectedAmountOut = parseBigInt(
        parsedJson?.expected_amount_out ?? parsedJson?.expectedAmountOut,
      )

      if (amountIn === null || amountOut === null) continue

      if (expectedAmountOut === null) {
        findings.push({
          reporter: this.name,
          level: 'WARN',
          code: 'EXPECTED_AMOUNT_UNAVAILABLE',
          message: 'Expected swap output amount unavailable — cannot verify slippage',
          evidence: { eventType, parsedJson },
        })
        continue
      }

      if (expectedAmountOut === BigInt(0)) continue

      // Slippage = (expectedOut - actualOut) / expectedOut * 10_000 bps
      const slippageBps =
        ((expectedAmountOut - amountOut) * BigInt(10_000)) / expectedAmountOut

      const limit = BigInt(policy.maxSlippageBps)
      const warnThreshold = (limit * BigInt(8)) / BigInt(10) // 80% of limit

      if (slippageBps > limit) {
        findings.push({
          reporter: this.name,
          level: 'BLOCK',
          code: 'SLIPPAGE_EXCEEDED',
          message: `Swap slippage ${slippageBps}bps exceeds policy limit of ${limit}bps`,
          evidence: { eventType, amountIn: amountIn.toString(), amountOut: amountOut.toString(), expectedAmountOut: expectedAmountOut.toString(), slippageBps: slippageBps.toString() },
        })
      } else if (slippageBps > warnThreshold) {
        findings.push({
          reporter: this.name,
          level: 'WARN',
          code: 'SLIPPAGE_NEAR_LIMIT',
          message: `Swap slippage ${slippageBps}bps is near the policy limit of ${limit}bps`,
          evidence: { eventType, amountIn: amountIn.toString(), amountOut: amountOut.toString(), expectedAmountOut: expectedAmountOut.toString(), slippageBps: slippageBps.toString() },
        })
      }
    }

    return findings
  }
}

function parseBigInt(value: unknown): bigint | null {
  if (value === undefined || value === null) return null
  try {
    return BigInt(String(value))
  } catch {
    return null
  }
}
