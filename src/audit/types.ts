export type AuditEventType = 'EXECUTED' | 'BLOCKED'

export interface AuditFinding {
  code: string
  level: string
  message: string
}

export interface AuditEvent {
  timestamp: number
  eventType: AuditEventType
  actionId: string
  actionLabel: string
  riskStatus: string
  findings: AuditFinding[]
  txDigest?: string
  sessionId?: string
}

export interface AuditQueryFilter {
  after?: number
  before?: number
  eventType?: AuditEventType
  sessionId?: string
}

/** Minimal action shape the AuditLogger needs — no blockchain types required. */
export interface AuditableAction {
  id: string
  label: string
}

/** Minimal report shape the AuditLogger needs — no blockchain types required. */
export interface AuditableReport {
  status: string
  findings: AuditFinding[]
}
