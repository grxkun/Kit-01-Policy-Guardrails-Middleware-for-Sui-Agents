import { z } from 'zod'

export const SpendLimitSchema = z.object({
  /** Max SUI (in MIST) per single action */
  perActionMist: z.bigint().optional(),
  /** Max SUI (in MIST) within the rolling window */
  rollingWindowMist: z.bigint().optional(),
  /** Rolling window duration in milliseconds */
  rollingWindowMs: z.number().optional().default(3_600_000), // 1 hour
})

export const SessionPolicySchema = z.object({
  /** Unique policy identifier */
  id: z.string().min(1),
  /** Human-readable name */
  name: z.string().min(1),
  /** Allowed Move package IDs (hex). If empty, all packages allowed */
  allowedPackages: z.array(z.string()).default([]),
  /** Explicitly blocked package IDs */
  blockedPackages: z.array(z.string()).default([]),
  /** Allowed Move function identifiers e.g. "0xPKG::module::fn" */
  allowedFunctions: z.array(z.string()).default([]),
  /** Spend limits for SUI and coin transfers */
  spendLimits: SpendLimitSchema.optional(),
  /** Max allowed slippage in basis points (e.g. 100 = 1%) */
  maxSlippageBps: z.number().optional().default(200),
  /** Session TTL in milliseconds from creation */
  ttlMs: z.number().optional().default(86_400_000), // 24h
  /** Whether to allow PTBs with WARN-level risk (default: false) */
  allowWarn: z.boolean().optional().default(false),
})

export type SpendLimit = z.infer<typeof SpendLimitSchema>
export type SessionPolicy = z.infer<typeof SessionPolicySchema>

export interface SessionKeyRecord {
  id: string
  policy: SessionPolicy
  publicKey: string       // base64 Ed25519
  privateKey: string      // base64 Ed25519 (ephemeral, in-memory only)
  createdAt: number
  expiresAt: number
  spendLog: SpendLogEntry[]
}

export interface SpendLogEntry {
  timestamp: number
  actionId: string
  amountMist: bigint
  txDigest?: string
}
