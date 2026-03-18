/**
 * Navi + Cetus multi-protocol agent example.
 * Demonstrates using the policy middleware with multiple allowed protocols
 * and tighter slippage requirements for a more complex DeFi strategy.
 *
 * Run: pnpm example:navi-cetus
 */
import { createPolicyMiddleware, PolicyBlockedError } from '../src/index.js'
import { Transaction } from '@mysten/sui/transactions'

// Well-known package IDs on Sui mainnet
const CETUS_PACKAGE = '0x1eabed72c53feb3805120a081dc15963c204dc8d0d0d445814d3de1b3cc6f0c4'
const NAVI_PACKAGE  = '0xd3b4994ee165b3a08b2e25bc76ad7c7b616e1c3f06b5b34b7b8f9e6c2d8c0e5b' // illustrative

const middleware = createPolicyMiddleware({
  policy: {
    id: 'navi-cetus-strategy',
    name: 'Navi + Cetus Yield Strategy',
    allowedPackages: [CETUS_PACKAGE, NAVI_PACKAGE],
    blockedPackages: [],
    allowedFunctions: [],
    spendLimits: {
      perActionMist: BigInt(500_000_000_000),       // 500 SUI per action
      rollingWindowMist: BigInt(5_000_000_000_000),  // 5000 SUI / hr
      rollingWindowMs: 3_600_000,
    },
    maxSlippageBps: 100,   // 1% max slippage (tighter for yield strategy)
    ttlMs: 8 * 3_600_000,  // 8h session
    allowWarn: true,        // Allow WARNs but log them
  },
  rpcUrl: 'https://fullnode.mainnet.sui.io:443',
  agentAddress: '0xYOUR_AGENT_ADDRESS',

  onRiskReport: (report, action) => {
    if (report.status === 'WARN') {
      console.warn(`[WARN] ${action.label} has risk warnings:`)
      report.findings
        .filter((f) => f.level === 'WARN')
        .forEach((f) => console.warn(`  • ${f.code}: ${f.message}`))
    }
    return true
  },

  onExecuted: (digest, action) => {
    console.log(`✅ ${action.label} → ${digest}`)
  },

  onBlocked: (report, action) => {
    console.error(`🚫 ${action.label} BLOCKED:`)
    report.findings
      .filter((f) => f.level === 'BLOCK')
      .forEach((f) => console.error(`  • ${f.code}: ${f.message}`))
  },
})

// --- Step 1: Supply USDC to Navi ---
async function supplyToNavi() {
  const ptb = new Transaction()
  // ptb.moveCall({ target: `${NAVI_PACKAGE}::lending::supply`, ... })

  return middleware.execute(
    {
      id: 'navi-supply-001',
      label: 'Supply 1000 USDC to Navi',
      ptb,
      estimatedSpendMist: BigInt(0), // No SUI outflow for USDC supply
    },
    async (action) => {
      console.log(`Executing: ${action.label}`)
      return '0xnavi-supply-digest'
    },
  )
}

// --- Step 2: Swap rewards via Cetus ---
async function swapRewardsCetus() {
  const ptb = new Transaction()
  // ptb.moveCall({ target: `${CETUS_PACKAGE}::router::swap`, ... })

  return middleware.execute(
    {
      id: 'cetus-swap-001',
      label: 'Swap NAVI rewards → SUI via Cetus',
      ptb,
      estimatedSpendMist: BigInt(1_000_000_000), // 1 SUI estimated
    },
    async (action) => {
      console.log(`Executing: ${action.label}`)
      return '0xcetus-swap-digest'
    },
  )
}

// --- Run the strategy ---
console.log('Starting Navi + Cetus yield strategy...')
console.log('Session:', middleware.getSessionInfo().id)

try {
  const naviDigest = await supplyToNavi()
  console.log(`Navi supply confirmed: ${naviDigest}`)

  const cetusDigest = await swapRewardsCetus()
  console.log(`Cetus swap confirmed: ${cetusDigest}`)

  console.log('Strategy cycle complete.')
} catch (err) {
  if (err instanceof PolicyBlockedError) {
    console.error('Strategy aborted by policy:', err.message)
  } else {
    throw err
  }
} finally {
  middleware.revoke()
  console.log('Session revoked.')
}
