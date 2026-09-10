import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import type {
  AuditEvent,
  AuditEventType,
  AuditQueryFilter,
  AuditableAction,
  AuditableReport,
} from './types.js'

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

export interface AuditSink {
  write(event: AuditEvent): void
}

/** In-memory sink — useful for testing and short-lived processes. */
export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = []

  write(event: AuditEvent): void {
    this.events.push(event)
  }

  query(filter?: AuditQueryFilter): AuditEvent[] {
    return applyFilter(this.events, filter)
  }

  clear(): void {
    this.events.length = 0
  }
}

/** Append-only JSON-lines file sink — one JSON object per line. */
export class FileAuditSink implements AuditSink {
  constructor(private readonly filePath: string) {}

  write(event: AuditEvent): void {
    appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf-8')
  }

  readAll(): AuditEvent[] {
    if (!existsSync(this.filePath)) return []
    return readFileSync(this.filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent)
  }

  query(filter?: AuditQueryFilter): AuditEvent[] {
    return applyFilter(this.readAll(), filter)
  }

  clear(): void {
    writeFileSync(this.filePath, '', 'utf-8')
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface AuditLoggerOptions {
  /** Stable session identifier included in every emitted event. */
  sessionId?: string
}

/**
 * Blockchain-agnostic audit logger.
 *
 * Wraps any AuditSink and provides a createHooks() factory that returns
 * the three hook callbacks accepted by createPolicyMiddleware().
 */
export class AuditLogger {
  constructor(
    private readonly sink: AuditSink,
    private readonly options: AuditLoggerOptions = {},
  ) {}

  log(event: AuditEvent): void {
    this.sink.write(event)
  }

  /**
   * Returns onExecuted and onBlocked hooks ready to pass to
   * createPolicyMiddleware(). The hooks are generic enough to work with any
   * action/report shape that satisfies the minimal AuditableAction /
   * AuditableReport interfaces, not just Sui types.
   */
  createHooks(): {
    onExecuted: (txDigest: string, action: AuditableAction) => void
    onBlocked: (report: AuditableReport, action: AuditableAction) => void
  } {
    return {
      onExecuted: (txDigest: string, action: AuditableAction): void => {
        this.log({
          timestamp: Date.now(),
          eventType: 'EXECUTED',
          actionId: action.id,
          actionLabel: action.label,
          riskStatus: 'PASS',
          findings: [],
          txDigest,
          sessionId: this.options.sessionId,
        })
      },

      onBlocked: (report: AuditableReport, action: AuditableAction): void => {
        this.log({
          timestamp: Date.now(),
          eventType: 'BLOCKED',
          actionId: action.id,
          actionLabel: action.label,
          riskStatus: report.status,
          findings: report.findings.map((f) => ({
            code: f.code,
            level: f.level,
            message: f.message,
          })),
          sessionId: this.options.sessionId,
        })
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyFilter(events: AuditEvent[], filter?: AuditQueryFilter): AuditEvent[] {
  if (!filter) return events
  return events.filter((e) => {
    if (filter.after !== undefined && e.timestamp < filter.after) return false
    if (filter.before !== undefined && e.timestamp > filter.before) return false
    if (filter.eventType !== undefined && e.eventType !== filter.eventType) return false
    if (filter.sessionId !== undefined && e.sessionId !== filter.sessionId) return false
    return true
  })
}
