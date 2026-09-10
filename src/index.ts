// Public API barrel — re-exports all public symbols

// Session
export { SessionKey } from './session/SessionKey.js'
export { PolicyEngine } from './session/SessionPolicy.js'
export { SessionStore } from './session/SessionStore.js'
export {
  SessionPolicySchema,
  SpendLimitSchema,
  type SessionPolicy,
  type SpendLimit,
  type SessionKeyRecord,
  type SpendLogEntry,
} from './session/types.js'

// Verifier
export { PTBVerifier } from './verifier/PTBVerifier.js'
export {
  aggregateRiskLevel,
  extractNetBalanceChange,
  extractEstimatedGas,
  extractMutatedObjects,
  buildDryRunFailedReport,
} from './verifier/RiskAnalyser.js'
export { SlippageReporter } from './verifier/reporters/SlippageReporter.js'
export { ContractReporter } from './verifier/reporters/ContractReporter.js'
export { DrainReporter } from './verifier/reporters/DrainReporter.js'
export type {
  RiskLevel,
  RiskFinding,
  RiskReport,
  Reporter,
} from './verifier/types.js'

// Middleware
export { createPolicyMiddleware, PolicyBlockedError } from './middleware/AgentPolicyMiddleware.js'
export type {
  AgentAction,
  PolicyMiddlewareOptions,
  ActionExecutor,
} from './middleware/types.js'

// Audit (blockchain-agnostic)
export { AuditLogger, InMemoryAuditSink, FileAuditSink } from './audit/AuditLogger.js'
export type { AuditSink } from './audit/AuditLogger.js'
export type {
  AuditEvent,
  AuditEventType,
  AuditFinding,
  AuditQueryFilter,
  AuditableAction,
  AuditableReport,
} from './audit/types.js'
