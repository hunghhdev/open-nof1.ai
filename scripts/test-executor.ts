/**
 * Test script for trading executor
 *
 * Tests DRY_RUN mode and safety guards
 * Run with: bun run scripts/test-executor.ts
 */

import { executeBuy, executeSell, updateStopLossTakeProfit } from "../lib/trading/executor";
import { prisma } from "../lib/prisma";
import { Symbol, ExecutionStatus, PositionStatus } from "@prisma/client";

// Ensure DRY_RUN is enabled
if (process.env.DRY_RUN !== "true") {
  console.error("❌ ERROR: DRY_RUN must be enabled for testing!");
  console.error("Set DRY_RUN=true in .env file");
  process.exit(1);
}

console.log("🧪 Testing Executor with DRY_RUN mode enabled\n");

/**
 * Test 1: Valid BUY operation
 */
async function testValidBuy() {
  console.log("═══════════════════════════════════════");
  console.log("Test 1: Valid BUY operation");
  console.log("═══════════════════════════════════════");

  const trade = await prisma.trade.create({
    data: {
      symbol: Symbol.BTC,
      operation: "Buy",
      pricing: 50000,
      amount: 0.0002, // ~$19 trade value with BTC at $95k
      leverage: 5,
      stopLoss: 94000,
      takeProfit: 98000,
    },
  });

  const result = await executeBuy({
    symbol: Symbol.BTC,
    amount: 0.0002,
    leverage: 5,
    stopLoss: 94000,
    takeProfit: 98000,
    tradeId: trade.id,
  });

  console.log("Result:", result);

  // Verify database state
  const updatedTrade = await prisma.trade.findUnique({
    where: { id: trade.id },
    include: { position: true },
  });

  console.log("Trade status:", updatedTrade?.status);
  console.log("Position created:", updatedTrade?.position ? "✅" : "❌");
  console.log("Position status:", updatedTrade?.position?.status);
  console.log("");
}

/**
 * Test 2: Reject duplicate position (KISS rule)
 */
async function testDuplicatePosition() {
  console.log("═══════════════════════════════════════");
  console.log("Test 2: Reject duplicate position");
  console.log("═══════════════════════════════════════");

  const trade = await prisma.trade.create({
    data: {
      symbol: Symbol.BTC,
      operation: "Buy",
      pricing: 50000,
      amount: 0.0002,
      leverage: 5,
    },
  });

  const result = await executeBuy({
    symbol: Symbol.BTC,
    amount: 0.0002,
    leverage: 5,
    tradeId: trade.id,
  });

  console.log("Result:", result);
  console.log("Should fail:", result.success === false ? "✅" : "❌");
  console.log("Error message:", result.error);
  console.log("");
}

/**
 * Test 3: Invalid leverage
 */
async function testInvalidLeverage() {
  console.log("═══════════════════════════════════════");
  console.log("Test 3: Invalid leverage (25x)");
  console.log("═══════════════════════════════════════");

  const trade = await prisma.trade.create({
    data: {
      symbol: Symbol.ETH,
      operation: "Buy",
      pricing: 3000,
      amount: 0.01,
      leverage: 25, // Invalid: max is 20x
    },
  });

  const result = await executeBuy({
    symbol: Symbol.ETH,
    amount: 0.01,
    leverage: 25,
    tradeId: trade.id,
  });

  console.log("Result:", result);
  console.log("Should fail:", result.success === false ? "✅" : "❌");
  console.log("Error message:", result.error);
  console.log("");
}

/**
 * Test 4: Invalid Take-Profit (below entry price)
 */
async function testInvalidTakeProfit() {
  console.log("═══════════════════════════════════════");
  console.log("Test 4: Invalid Take-Profit");
  console.log("═══════════════════════════════════════");

  const trade = await prisma.trade.create({
    data: {
      symbol: Symbol.BNB,
      operation: "Buy",
      pricing: 600,
      amount: 0.02, // ~$13 trade value
      leverage: 5,
      stopLoss: 600,
      takeProfit: 650, // This will be tested against current price (~930), should be invalid if below
    },
  });

  const result = await executeBuy({
    symbol: Symbol.BNB,
    amount: 0.02,
    leverage: 5,
    stopLoss: 600,
    takeProfit: 650, // TP below current price is invalid
    tradeId: trade.id,
  });

  console.log("Result:", result);
  console.log("Should fail:", result.success === false ? "✅" : "❌");
  console.log("Error message:", result.error);
  console.log("");
}

/**
 * Test 5: Valid SELL operation
 */
async function testValidSell() {
  console.log("═══════════════════════════════════════");
  console.log("Test 5: Valid SELL operation");
  console.log("═══════════════════════════════════════");

  const trade = await prisma.trade.create({
    data: {
      symbol: Symbol.BTC,
      operation: "Sell",
      percentage: 100,
    },
  });

  const result = await executeSell({
    symbol: Symbol.BTC,
    percentage: 100,
    tradeId: trade.id,
  });

  console.log("Result:", result);
  console.log("PnL calculated:", result.success ? "✅" : "❌");

  // Verify position was closed
  const closedPosition = await prisma.position.findFirst({
    where: {
      symbol: Symbol.BTC,
      status: PositionStatus.CLOSED,
    },
  });

  console.log("Position closed:", closedPosition ? "✅" : "❌");
  console.log("Realized PnL:", closedPosition?.realizedPnl?.toFixed(2));
  console.log("");
}

/**
 * Test 6: Update Stop-Loss and Take-Profit
 */
async function testUpdateSLTP() {
  console.log("═══════════════════════════════════════");
  console.log("Test 6: Update SL/TP (HOLD operation)");
  console.log("═══════════════════════════════════════");

  // First create a new position for ETH
  const buyTrade = await prisma.trade.create({
    data: {
      symbol: Symbol.ETH,
      operation: "Buy",
      pricing: 3000,
      amount: 0.004, // ~$12 trade value
      leverage: 5,
      stopLoss: 3000,
      takeProfit: 3300,
    },
  });

  await executeBuy({
    symbol: Symbol.ETH,
    amount: 0.004,
    leverage: 5,
    stopLoss: 3000,
    takeProfit: 3300,
    tradeId: buyTrade.id,
  });

  // Now update SL/TP
  const holdTrade = await prisma.trade.create({
    data: {
      symbol: Symbol.ETH,
      operation: "Hold",
      stopLoss: 3050, // Trailing up
      takeProfit: 3400, // Increase target
    },
  });

  const result = await updateStopLossTakeProfit({
    symbol: Symbol.ETH,
    stopLoss: 3050,
    takeProfit: 3400,
    tradeId: holdTrade.id,
  });

  console.log("Result:", result);

  // Verify position was updated
  const position = await prisma.position.findFirst({
    where: {
      symbol: Symbol.ETH,
      status: PositionStatus.OPEN,
    },
  });

  console.log("SL updated:", position?.currentStopLoss === 3050 ? "✅" : "❌");
  console.log("TP updated:", position?.currentTakeProfit === 3400 ? "✅" : "❌");
  console.log("");
}

/**
 * Main test runner
 */
async function runTests() {
  try {
    console.log("🚀 Starting Executor Tests\n");
    console.log("Environment:");
    console.log("- DRY_RUN:", process.env.DRY_RUN);
    console.log("- Database:", process.env.DATABASE_URL?.split("@")[1]);
    console.log("");

    // Clean up test data
    console.log("🧹 Cleaning up test data...");
    await prisma.trade.deleteMany({});
    await prisma.position.deleteMany({});
    console.log("✅ Database cleaned\n");

    // Run tests
    await testValidBuy();
    await testDuplicatePosition();
    await testInvalidLeverage();
    await testInvalidTakeProfit();
    await testValidSell();
    await testUpdateSLTP();

    console.log("═══════════════════════════════════════");
    console.log("✅ All tests completed!");
    console.log("═══════════════════════════════════════");
    console.log("");
    console.log("📊 Summary:");

    const totalTrades = await prisma.trade.count();
    const filledTrades = await prisma.trade.count({
      where: { status: ExecutionStatus.FILLED },
    });
    const failedTrades = await prisma.trade.count({
      where: { status: ExecutionStatus.FAILED },
    });
    const openPositions = await prisma.position.count({
      where: { status: PositionStatus.OPEN },
    });
    const closedPositions = await prisma.position.count({
      where: { status: PositionStatus.CLOSED },
    });

    console.log(`- Total trades: ${totalTrades}`);
    console.log(`- Filled trades: ${filledTrades}`);
    console.log(`- Failed trades: ${failedTrades}`);
    console.log(`- Open positions: ${openPositions}`);
    console.log(`- Closed positions: ${closedPositions}`);
    console.log("");

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("❌ Test failed:", errorMessage);
    console.error(error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run tests
runTests();
