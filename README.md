# @sui-agent-kit/policy

> **Kit 01 — Policy & Guardrails Middleware for Sui Agents**

A fully functional TypeScript middleware package that wraps any Sui agent's action pipeline with scoped authority enforcement and PTB pre-flight risk verification. Kit 01 is the unlock for institutional and retail trust alike — the PTB dry-run verifier is the one thing that lets a developer confidently hand an agent a real key.

---

## Overview

`@sui-agent-kit/policy` provides a composable middleware layer that sits between your AI/autonomous agent and the Sui blockchain. Every action your agent wants to execute is first validated against a **SessionPolicy** (allowlisted packages, spend limits, slippage caps) and then dry-run through the Sui RPC. A chain of **Reporter** plugins analyses the simulated effects for slippage, spend-limit violations, and drain patterns before returning a `RiskReport` with `PASS`, `WARN`, or `BLOCK` status. Only `PASS` actions (or `WARN` with `allowWarn: true`) are submitted on-chain.

---

## Architecture

```
Agent Action
     │
     ▼
┌────────────────────────┐
│     PolicyEngine       │  ← validates call targets, spend limits, TTL
└──────────┬─────────────┘
           │ PASS
           ▼
┌────────────────────────┐
│      PTBVerifier       │  ← suix_dryRunTransactionBlock
└──────────┬─────────────┘
           │
     ┌─────┴──────────────────────────┐
     ▼             ▼                  ▼
┌──────────┐ ┌──────────┐   ┌─────────────────┐
│ Contract │ │  Drain   │   │    Slippage     │
│ Reporter │ │ Reporter │   │    Reporter     │
└──────────┘ └──────────┘   └─────────────────┘
     │             │                  │
     └─────────────┴──────────────────┘
                   │
                   ▼
            ┌────────────┐
            │ RiskReport │  PASS / WARN / BLOCK
            └─────┬──────┘
                  │
          ┌───────┴────────┐
          ▼                ▼
       Execute           Block
    (returns txDigest)  (throws PolicyBlockedError)
```

---

## Installation

```bash
pnpm add @sui-agent-kit/policy
```

---

## Quick Start

```typescript
import { createPolicyMiddleware, PolicyBlockedError } from '@sui-agent-kit/policy'
import { Transaction } from '@mysten/sui/transactions'

const middleware = createPolicyMiddleware({
  policy: {
    id: 'conservative-dex',
    name: 'Conservative DEX Policy',
    allowedPackages: [
      '0x1eabed72c53feb3805120a081dc15963c204dc8d0d0d445814d3de1b3cc6f0c4', // Cetus
    ],
    spendLimits: {
      perActionMist: BigInt(100_000_000_000),      // 100 SUI
      rollingWindowMist: BigInt(1_000_000_000_000), // 1000 SUI / hr
      rollingWindowMs: 3_600_000,
    },
    maxSlippageBps: 150,
    allowWarn: false,
  },
  rpcUrl: 'https://fullnode.mainnet.sui.io:443',
  agentAddress: '0xYOUR_AGENT_ADDRESS',
  onRiskReport: (report, action) => {
    console.log(`[Risk] ${action.label}: ${report.status}`)
    return true
  },
  onExecuted: (digest, action) => {
    console.log(`[OK] ${action.label} executed: ${digest}`)
  },
  onBlocked: (report, action) => {
    console.error(`[BLOCKED] ${action.label}`)
  },
})

const ptb = new Transaction()
// ptb.moveCall({ target: '0x1eab...::router::swap', ... })

try {
  const digest = await middleware.execute(
    {
      id: 'swap-001',
      label: 'Swap 10 SUI → USDC via Cetus',
      ptb,
      estimatedSpendMist: BigInt(10_000_000_000),
    },
    async (action) => {
      // Sign and submit with your keypair
      return '0xtxdigest'
    },
  )
  console.log('Executed:', digest)
} catch (err) {
  if (err instanceof PolicyBlockedError) {
    console.error('Blocked:', err.message)
  }
} finally {
  middleware.revoke()
}
```

---

## Policy Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | `string` | required | Unique policy identifier |
| `name` | `string` | required | Human-readable name |
| `allowedPackages` | `string[]` | `[]` | Allowed Move package IDs. Empty = all allowed |
| `blockedPackages` | `string[]` | `[]` | Explicitly blocked package IDs |
| `allowedFunctions` | `string[]` | `[]` | Allowed `pkg::module::fn` targets. Empty = all allowed |
| `spendLimits.perActionMist` | `bigint` | `undefined` | Max SUI (MIST) per single action |
| `spendLimits.rollingWindowMist` | `bigint` | `undefined` | Max SUI (MIST) in rolling window |
| `spendLimits.rollingWindowMs` | `number` | `3_600_000` | Rolling window duration (ms) |
| `maxSlippageBps` | `number` | `200` | Max swap slippage in basis points (100 = 1%) |
| `ttlMs` | `number` | `86_400_000` | Session key TTL (ms). Default = 24h |
| `allowWarn` | `boolean` | `false` | Whether to execute actions with WARN-level risk |

---

## Risk Report

All built-in reporter codes:

| Code | Level | Reporter | Description |
|---|---|---|---|
| `SLIPPAGE_EXCEEDED` | BLOCK | SlippageReporter | Actual swap slippage exceeds `maxSlippageBps` |
| `SLIPPAGE_NEAR_LIMIT` | WARN | SlippageReporter | Slippage is 80–100% of `maxSlippageBps` |
| `EXPECTED_AMOUNT_UNAVAILABLE` | WARN | SlippageReporter | Expected swap output not in event — cannot verify slippage |
| `BLOCKED_CONTRACT` | BLOCK | ContractReporter | Package ID is in `blockedPackages` |
| `UNAUTHORIZED_CONTRACT` | BLOCK | ContractReporter | Package ID not in `allowedPackages` (when list is non-empty) |
| `SPEND_LIMIT_EXCEEDED` | BLOCK | DrainReporter | SUI outflow exceeds `spendLimits.perActionMist` |
| `LARGE_BALANCE_DRAIN` | WARN | DrainReporter | Large SUI outflow detected from sender |
| `DRY_RUN_FAILED` | BLOCK | PTBVerifier | `dryRunTransactionBlock` failed or simulation errored |
| `SESSION_EXPIRED` | BLOCK | SessionPolicy | Session key TTL has elapsed |

---

## Extending with Custom Reporters

Implement the `Reporter` interface and pass your reporter to `PTBVerifier`:

```typescript
import type { Reporter, RiskFinding } from '@sui-agent-kit/policy'
import type { SessionPolicy } from '@sui-agent-kit/policy'

class MyCustomReporter implements Reporter {
  name = 'MyCustomReporter'

  analyse(dryRun: unknown, policy: SessionPolicy): RiskFinding[] {
    const findings: RiskFinding[] = []
    // inspect dryRun.effects, dryRun.events, etc.
    return findings
  }
}

// Pass to PTBVerifier directly:
import { PTBVerifier } from '@sui-agent-kit/policy'
import { SuiClient } from '@mysten/sui/client'

const verifier = new PTBVerifier(
  new SuiClient({ url: 'https://fullnode.mainnet.sui.io' }),
  [new MyCustomReporter()],
  policy,
)
```

---

## Move Contracts

The `src/move/sources/` directory contains two optional on-chain contracts:

### `session_key.move`
Creates a `SessionKeyObject` owned by the agent. Stores the Ed25519 public key, expiry timestamp, per-action spend limit, and allowed package list on-chain. Use this when you need:
- **Auditability**: on-chain record of which sessions were active and what limits they had
- **Multi-agent coordination**: other agents or contracts can verify session validity
- **Revocation broadcasts**: publishing a revocation on-chain is visible to all observers

### `policy_registry.move`
A shared `PolicyRegistry` object that stores named `PolicyTemplate` structs on-chain. Use this for:
- **Policy governance**: DAOs or multisigs can register and update approved policies
- **Agent bootstrapping**: agents read their policy from the registry at startup instead of hardcoding

> **Note:** Both contracts are optional for v0.1. The TypeScript middleware is fully functional without them. On-chain objects add auditability and multi-agent coordination.

---

## Running Tests

```bash
pnpm test
```

Watch mode:

```bash
pnpm test:watch
```

---

## Roadmap

- [ ] **Session key delegation** — sub-agents can be granted sub-scoped session keys derived from a parent key
- [ ] **Walrus audit log persistence** — append-only audit trail of all actions and risk reports stored on Walrus
- [ ] **On-chain policy registry integration** — agents read `SessionPolicy` from `policy_registry.move` at startup
- [ ] **Multi-sig session approval** — require N-of-M approval before a session key becomes active
- [ ] **Custom reporter marketplace** — community-contributed reporters for protocol-specific risk checks

