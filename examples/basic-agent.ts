/**
 * Basic agent example: demonstrates how to use the Policy Middleware
 * to wrap a swap action with conservative DEX policy enforcement.
 *
 * Run: pnpm example:basic
 */
import { createPolicyMiddleware } from '../src/index.js'
import { Transaction } from '@mysten/sui/transactions'
import { SuiClient } from '@mysten/sui/client'

const suiClient = new SuiClient({ url: 'https://fullnode.mainnet.sui.io:443' })

const middleware = createPolicyMiddleware({
  policy: {
    id: 'conservative-dex',
    name: 'Conservative DEX Policy',
    allowedPackages: [
      '0x1eabed72c53feb3805120a081dc15963c204dc8d0d0d445814d3de1b3cc6f0c4', // Cetus
    ],
    blockedPackages: [],
    allowedFunctions: [],
    spendLimits: {
      perActionMist: BigInt(100_000_000_000),      // 100 SUI
      rollingWindowMist: BigInt(1_000_000_000_000), // 1000 SUI / hr
      rollingWindowMs: 3_600_000,
    },
    maxSlippageBps: 150,
    ttlMs: 86_400_000,
    allowWarn: false,
  },
  rpcUrl: 'https://fullnode.mainnet.sui.io:443',
  agentAddress: '0xYOUR_AGENT_ADDRESS',
  onRiskReport: (report, action) => {
    console.log(`[Risk] ${action.label}: ${report.status}`)
    report.findings.forEach((f) => console.log(`  [${f.level}] ${f.code}: ${f.message}`))
    return true
  },
  onExecuted: (digest, action) => {
    console.log(`[OK] ${action.label} executed: ${digest}`)
  },
  onBlocked: (report, action) => {
    console.error(
      `[BLOCKED] ${action.label}:`,
      report.findings.filter((f) => f.level === 'BLOCK'),
    )
  },
})

// Simulate an agent action
const ptb = new Transaction()
// ptb.moveCall({ target: '0x1eab...::router::swap', ... })

console.log('Session info:', middleware.getSessionInfo())

try {
  await middleware.execute(
    {
      id: 'swap-001',
      label: 'Swap 10 SUI → USDC via Cetus',
      ptb,
      estimatedSpendMist: BigInt(10_000_000_000),
    },
    async (action) => {
      // Real executor: sign and submit with session key
      console.log(`Executing action: ${action.label}`)
      // const result = await suiClient.signAndExecuteTransaction({ ... })
      // return result.digest
      return '0xmock-tx-digest'
    },
  )
} catch (err: unknown) {
  if (err instanceof Error) {
    console.error('Action failed:', err.message)
  }
} finally {
  // Always revoke session key when done
  middleware.revoke()
}
