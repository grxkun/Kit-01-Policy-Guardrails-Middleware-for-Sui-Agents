export type RiskLevel = 'PASS' | 'WARN' | 'BLOCK'

export interface RiskFinding {
  /** Reporter that produced this finding */
  reporter: string
  level: RiskLevel
  code: string            // e.g. "SLIPPAGE_EXCEEDED"
  message: string         // human-readable explanation
  /** Raw data supporting the finding (JSON-serialisable) */
  evidence?: unknown
}

export interface RiskReport {
  status: RiskLevel       // max severity across all findings
  findings: RiskFinding[]
  /** Simulated gas cost in MIST */
  estimatedGasMist: bigint
  /** Net SUI balance change in MIST (negative = outflow) */
  netBalanceChangeMist: bigint
  /** All object IDs mutated by the simulated PTB */
  mutatedObjects: string[]
  /** Raw dry-run response from the RPC */
  rawDryRun: unknown
  generatedAt: number
}

export interface Reporter {
  name: string
  analyse(dryRun: unknown, policy: import('../session/types.js').SessionPolicy): RiskFinding[]
}
