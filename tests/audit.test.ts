import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AuditLogger,
  InMemoryAuditSink,
  FileAuditSink,
} from '../src/audit/AuditLogger.js'
import type { AuditableAction, AuditableReport, AuditEvent } from '../src/audit/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAction(overrides: Partial<AuditableAction> = {}): AuditableAction {
  return { id: 'action-001', label: 'Test Action', ...overrides }
}

function makeBlockReport(overrides: Partial<AuditableReport> = {}): AuditableReport {
  return {
    status: 'BLOCK',
    findings: [{ code: 'MOCK_BLOCK', level: 'BLOCK', message: 'blocked' }],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// InMemoryAuditSink
// ---------------------------------------------------------------------------

describe('InMemoryAuditSink', () => {
  let sink: InMemoryAuditSink

  beforeEach(() => {
    sink = new InMemoryAuditSink()
  })

  it('stores written events', () => {
    const event: AuditEvent = {
      timestamp: 1000,
      eventType: 'EXECUTED',
      actionId: 'a1',
      actionLabel: 'Swap',
      riskStatus: 'PASS',
      findings: [],
    }
    sink.write(event)
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]).toEqual(event)
  })

  it('clear() empties the store', () => {
    sink.write({ timestamp: 1, eventType: 'EXECUTED', actionId: 'a', actionLabel: 'x', riskStatus: 'PASS', findings: [] })
    sink.clear()
    expect(sink.events).toHaveLength(0)
  })

  it('query() returns all events when no filter given', () => {
    sink.write({ timestamp: 1000, eventType: 'EXECUTED', actionId: 'a1', actionLabel: 'A', riskStatus: 'PASS', findings: [] })
    sink.write({ timestamp: 2000, eventType: 'BLOCKED', actionId: 'a2', actionLabel: 'B', riskStatus: 'BLOCK', findings: [] })
    expect(sink.query()).toHaveLength(2)
  })

  it('query() filters by eventType', () => {
    sink.write({ timestamp: 1000, eventType: 'EXECUTED', actionId: 'a1', actionLabel: 'A', riskStatus: 'PASS', findings: [] })
    sink.write({ timestamp: 2000, eventType: 'BLOCKED', actionId: 'a2', actionLabel: 'B', riskStatus: 'BLOCK', findings: [] })
    expect(sink.query({ eventType: 'BLOCKED' })).toHaveLength(1)
    expect(sink.query({ eventType: 'EXECUTED' })).toHaveLength(1)
  })

  it('query() filters by after/before timestamp', () => {
    sink.write({ timestamp: 1000, eventType: 'EXECUTED', actionId: 'a1', actionLabel: 'A', riskStatus: 'PASS', findings: [] })
    sink.write({ timestamp: 3000, eventType: 'EXECUTED', actionId: 'a2', actionLabel: 'B', riskStatus: 'PASS', findings: [] })
    expect(sink.query({ after: 2000 })).toHaveLength(1)
    expect(sink.query({ before: 2000 })).toHaveLength(1)
    expect(sink.query({ after: 500, before: 2000 })).toHaveLength(1)
  })

  it('query() filters by sessionId', () => {
    sink.write({ timestamp: 1, eventType: 'EXECUTED', actionId: 'a1', actionLabel: 'A', riskStatus: 'PASS', findings: [], sessionId: 'sess-1' })
    sink.write({ timestamp: 2, eventType: 'EXECUTED', actionId: 'a2', actionLabel: 'B', riskStatus: 'PASS', findings: [], sessionId: 'sess-2' })
    expect(sink.query({ sessionId: 'sess-1' })).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// FileAuditSink
// ---------------------------------------------------------------------------

describe('FileAuditSink', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-test-'))
    logPath = join(tmpDir, 'audit.jsonl')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes and reads back events', () => {
    const sink = new FileAuditSink(logPath)
    sink.write({ timestamp: 1000, eventType: 'EXECUTED', actionId: 'a1', actionLabel: 'Swap', riskStatus: 'PASS', findings: [] })
    const events = sink.readAll()
    expect(events).toHaveLength(1)
    expect(events[0].actionId).toBe('a1')
  })

  it('readAll() returns empty array when file does not exist', () => {
    const sink = new FileAuditSink(join(tmpDir, 'nonexistent.jsonl'))
    expect(sink.readAll()).toEqual([])
  })

  it('appends multiple events across writes', () => {
    const sink = new FileAuditSink(logPath)
    sink.write({ timestamp: 1, eventType: 'EXECUTED', actionId: 'a1', actionLabel: 'A', riskStatus: 'PASS', findings: [] })
    sink.write({ timestamp: 2, eventType: 'BLOCKED', actionId: 'a2', actionLabel: 'B', riskStatus: 'BLOCK', findings: [] })
    expect(sink.readAll()).toHaveLength(2)
  })

  it('clear() resets the file', () => {
    const sink = new FileAuditSink(logPath)
    sink.write({ timestamp: 1, eventType: 'EXECUTED', actionId: 'a1', actionLabel: 'A', riskStatus: 'PASS', findings: [] })
    sink.clear()
    expect(sink.readAll()).toHaveLength(0)
  })

  it('query() filters events from file', () => {
    const sink = new FileAuditSink(logPath)
    sink.write({ timestamp: 1000, eventType: 'EXECUTED', actionId: 'a1', actionLabel: 'A', riskStatus: 'PASS', findings: [] })
    sink.write({ timestamp: 2000, eventType: 'BLOCKED', actionId: 'a2', actionLabel: 'B', riskStatus: 'BLOCK', findings: [] })
    expect(sink.query({ eventType: 'BLOCKED' })).toHaveLength(1)
    expect(sink.query({ after: 1500 })).toHaveLength(1)
  })

  it('preserves all fields round-trip', () => {
    const sink = new FileAuditSink(logPath)
    const event: AuditEvent = {
      timestamp: 9999,
      eventType: 'BLOCKED',
      actionId: 'act-x',
      actionLabel: 'Drain attempt',
      riskStatus: 'BLOCK',
      findings: [{ code: 'SPEND_LIMIT_EXCEEDED', level: 'BLOCK', message: 'over limit' }],
      sessionId: 'sess-abc',
    }
    sink.write(event)
    const [back] = sink.readAll()
    expect(back).toEqual(event)
  })
})

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

describe('AuditLogger', () => {
  let sink: InMemoryAuditSink
  let logger: AuditLogger

  beforeEach(() => {
    sink = new InMemoryAuditSink()
    logger = new AuditLogger(sink)
  })

  it('log() writes an event to the sink', () => {
    logger.log({
      timestamp: Date.now(),
      eventType: 'EXECUTED',
      actionId: 'a1',
      actionLabel: 'Swap',
      riskStatus: 'PASS',
      findings: [],
    })
    expect(sink.events).toHaveLength(1)
  })

  describe('createHooks()', () => {
    it('onExecuted writes an EXECUTED event', () => {
      const { onExecuted } = logger.createHooks()
      onExecuted('0xdigest123', makeAction())
      expect(sink.events).toHaveLength(1)
      const e = sink.events[0]
      expect(e.eventType).toBe('EXECUTED')
      expect(e.txDigest).toBe('0xdigest123')
      expect(e.actionId).toBe('action-001')
      expect(e.riskStatus).toBe('PASS')
      expect(e.findings).toEqual([])
    })

    it('onBlocked writes a BLOCKED event with findings', () => {
      const { onBlocked } = logger.createHooks()
      onBlocked(makeBlockReport(), makeAction({ id: 'action-999', label: 'Drain' }))
      expect(sink.events).toHaveLength(1)
      const e = sink.events[0]
      expect(e.eventType).toBe('BLOCKED')
      expect(e.riskStatus).toBe('BLOCK')
      expect(e.findings).toHaveLength(1)
      expect(e.findings[0].code).toBe('MOCK_BLOCK')
      expect(e.actionId).toBe('action-999')
      expect(e.txDigest).toBeUndefined()
    })

    it('includes sessionId from logger options', () => {
      const loggerWithSession = new AuditLogger(sink, { sessionId: 'sess-xyz' })
      const { onExecuted } = loggerWithSession.createHooks()
      onExecuted('digest', makeAction())
      expect(sink.events[0].sessionId).toBe('sess-xyz')
    })

    it('omits sessionId when not configured', () => {
      const { onExecuted } = logger.createHooks()
      onExecuted('digest', makeAction())
      expect(sink.events[0].sessionId).toBeUndefined()
    })

    it('records timestamp close to now', () => {
      const before = Date.now()
      const { onExecuted } = logger.createHooks()
      onExecuted('digest', makeAction())
      const after = Date.now()
      expect(sink.events[0].timestamp).toBeGreaterThanOrEqual(before)
      expect(sink.events[0].timestamp).toBeLessThanOrEqual(after)
    })

    it('hooks accept any object with id and label (not just AgentAction)', () => {
      const { onExecuted, onBlocked } = logger.createHooks()
      const genericAction = { id: 'gen-1', label: 'Generic action' }
      const genericReport = { status: 'BLOCK', findings: [] }
      onExecuted('digest', genericAction)
      onBlocked(genericReport, genericAction)
      expect(sink.events).toHaveLength(2)
    })
  })
})
