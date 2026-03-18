import type { SessionPolicy } from '../session/types.js'
import type { RiskReport } from '../verifier/types.js'
import type { Transaction } from '@mysten/sui/transactions'

export interface AgentAction {
  /** Unique action identifier for logging */
  id: string
  /** Human label for this action */
  label: string
  /** The assembled PTB */
  ptb: Transaction
  /** Estimated SUI outflow in MIST (agent's self-report, verified separately) */
  estimatedSpendMist?: bigint
}

export interface PolicyMiddlewareOptions {
  policy: SessionPolicy
  /** Sui RPC URL */
  rpcUrl: string
  /** Agent's Sui address (for dry-run sender) */
  agentAddress: string
  /** Called before execution with the risk report — return false to abort */
  onRiskReport?: (report: RiskReport, action: AgentAction) => boolean | Promise<boolean>
  /** Called after successful execution */
  onExecuted?: (txDigest: string, action: AgentAction) => void
  /** Called when an action is blocked */
  onBlocked?: (report: RiskReport, action: AgentAction) => void
}

export type ActionExecutor = (action: AgentAction) => Promise<string> // returns txDigest
