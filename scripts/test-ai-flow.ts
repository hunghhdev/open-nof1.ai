/**
 * Test script for full AI trading flow
 *
 * Tests the complete flow: AI decision → Execution → Database updates
 * Run with: bun run scripts/test-ai-flow.ts
 */

import { run } from "../lib/ai/run";
import { prisma } from "../lib/prisma";
import { ExecutionStatus, PositionStatus } from "@prisma/client";

// Ensure DRY_RUN is enabled
if (process.env.DRY_RUN !== "true") {
  console.error("❌ ERROR: DRY_RUN must be enabled for testing!");
  console.error("Set DRY_RUN=true in .env file");
  process.exit(1);
}

console.log("🧪 Testing Full AI Trading Flow with DRY_RUN mode\n");

async function testAIFlow() {
  try {
    console.log("═══════════════════════════════════════");
    console.log("Environment Check");
    console.log("═══════════════════════════════════════");
    console.log("- DRY_RUN:", process.env.DRY_RUN);
    console.log("- START_MONEY:", process.env.START_MONEY);
    console.log("- TRADING_SYMBOLS:", process.env.TRADING_SYMBOLS);
    console.log("- Database:", process.env.DATABASE_URL?.split("@")[1]);
    console.log("");

    // Get initial state
    console.log("═══════════════════════════════════════");
    console.log("Initial Database State");
    console.log("═══════════════════════════════════════");

    const initialChats = await prisma.chat.count();
    const initialTrades = await prisma.trade.count();
    const initialPositions = await prisma.position.count();

    console.log(`- Chats: ${initialChats}`);
    console.log(`- Trades: ${initialTrades}`);
    console.log(`- Positions: ${initialPositions}`);
    console.log("");

    // Run AI trading loop
    console.log("═══════════════════════════════════════");
    console.log("Running AI Trading Loop");
    console.log("═══════════════════════════════════════");

    const startMoney = parseFloat(process.env.START_MONEY || "20");
    await run(startMoney);

    console.log("");

    // Check results
    console.log("═══════════════════════════════════════");
    console.log("Results After AI Execution");
    console.log("═══════════════════════════════════════");

    const finalChats = await prisma.chat.count();
    const finalTrades = await prisma.trade.count();
    const finalPositions = await prisma.position.count();

    console.log(`- Chats: ${finalChats} (${finalChats - initialChats > 0 ? "+" : ""}${finalChats - initialChats})`);
    console.log(`- Trades: ${finalTrades} (${finalTrades - initialTrades > 0 ? "+" : ""}${finalTrades - initialTrades})`);
    console.log(`- Positions: ${finalPositions} (${finalPositions - initialPositions > 0 ? "+" : ""}${finalPositions - initialPositions})`);
    console.log("");

    // Show detailed trade breakdown
    console.log("═══════════════════════════════════════");
    console.log("Trade Breakdown");
    console.log("═══════════════════════════════════════");

    const buyTrades = await prisma.trade.count({ where: { operation: "Buy" } });
    const sellTrades = await prisma.trade.count({ where: { operation: "Sell" } });
    const holdTrades = await prisma.trade.count({ where: { operation: "Hold" } });

    console.log(`- Buy operations: ${buyTrades}`);
    console.log(`- Sell operations: ${sellTrades}`);
    console.log(`- Hold operations: ${holdTrades}`);
    console.log("");

    // Show execution status breakdown
    console.log("═══════════════════════════════════════");
    console.log("Execution Status");
    console.log("═══════════════════════════════════════");

    const pending = await prisma.trade.count({ where: { status: ExecutionStatus.PENDING } });
    const executing = await prisma.trade.count({ where: { status: ExecutionStatus.EXECUTING } });
    const filled = await prisma.trade.count({ where: { status: ExecutionStatus.FILLED } });
    const failed = await prisma.trade.count({ where: { status: ExecutionStatus.FAILED } });

    console.log(`- Pending: ${pending}`);
    console.log(`- Executing: ${executing}`);
    console.log(`- Filled: ${filled}`);
    console.log(`- Failed: ${failed}`);
    console.log("");

    // Show position status
    console.log("═══════════════════════════════════════");
    console.log("Position Status");
    console.log("═══════════════════════════════════════");

    const openPositions = await prisma.position.count({ where: { status: PositionStatus.OPEN } });
    const closedPositions = await prisma.position.count({ where: { status: PositionStatus.CLOSED } });

    console.log(`- Open: ${openPositions}`);
    console.log(`- Closed: ${closedPositions}`);
    console.log("");

    // Show recent trades in detail
    console.log("═══════════════════════════════════════");
    console.log("Recent Trades (Latest 3)");
    console.log("═══════════════════════════════════════");

    const recentTrades = await prisma.trade.findMany({
      take: 3,
      orderBy: { createdAt: "desc" },
      include: { position: true },
    });

    recentTrades.forEach((trade, idx) => {
      console.log(`\n${idx + 1}. ${trade.operation} ${trade.symbol}`);
      console.log(`   Status: ${trade.status}`);
      if (trade.operation === "Buy") {
        console.log(`   Amount: ${trade.amount} @ $${trade.executedPrice || trade.pricing}`);
        console.log(`   Leverage: ${trade.leverage}x`);
        console.log(`   Stop-Loss: ${trade.stopLoss ? "$" + trade.stopLoss : "N/A"}`);
        console.log(`   Take-Profit: ${trade.takeProfit ? "$" + trade.takeProfit : "N/A"}`);
      } else if (trade.operation === "Sell") {
        console.log(`   Percentage: ${trade.percentage}%`);
        console.log(`   Price: $${trade.executedPrice}`);
        if (trade.position?.realizedPnl) {
          console.log(`   Realized PnL: ${trade.position.realizedPnl >= 0 ? "+" : ""}$${trade.position.realizedPnl.toFixed(2)}`);
        }
      }
      if (trade.error) {
        console.log(`   ❌ Error: ${trade.error}`);
      }
    });

    console.log("");

    // Show AI reasoning for latest decision
    console.log("═══════════════════════════════════════");
    console.log("Latest AI Reasoning");
    console.log("═══════════════════════════════════════");

    const latestChat = await prisma.chat.findFirst({
      orderBy: { createdAt: "desc" },
      include: { trades: true },
    });

    if (latestChat) {
      console.log(`Model: ${latestChat.model}`);
      console.log(`Chat: ${latestChat.chat}`);
      console.log(`Trades: ${latestChat.trades.map(t => `${t.operation} ${t.symbol}`).join(", ")}`);
      console.log("");
      console.log("Reasoning preview:");
      console.log(latestChat.reasoning.substring(0, 300) + "...");
    }

    console.log("");
    console.log("═══════════════════════════════════════");
    console.log("✅ AI Flow Test Completed Successfully");
    console.log("═══════════════════════════════════════");
    console.log("");

    // Validation checks
    console.log("🔍 Validation Checks:");
    const allTrades = await prisma.trade.findMany();
    let validationsPassed = 0;
    let validationsFailed = 0;

    // Check 1: All trades have valid status
    const invalidStatus = allTrades.filter(t => !t.status);
    if (invalidStatus.length === 0) {
      console.log("✅ All trades have valid status");
      validationsPassed++;
    } else {
      console.log(`❌ ${invalidStatus.length} trades have invalid status`);
      validationsFailed++;
    }

    // Check 2: Buy trades should have position links (if filled)
    const buyTradesFilled = allTrades.filter(t => t.operation === "Buy" && t.status === ExecutionStatus.FILLED);
    const buyTradesWithoutPosition = buyTradesFilled.filter(t => !t.positionId);
    if (buyTradesWithoutPosition.length === 0) {
      console.log("✅ All filled Buy trades have position links");
      validationsPassed++;
    } else {
      console.log(`❌ ${buyTradesWithoutPosition.length} filled Buy trades missing position links`);
      validationsFailed++;
    }

    // Check 3: No duplicate open positions per symbol
    const openPositionsDetail = await prisma.position.findMany({
      where: { status: PositionStatus.OPEN },
    });
    const symbolCounts = openPositionsDetail.reduce((acc, pos) => {
      acc[pos.symbol] = (acc[pos.symbol] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const duplicates = Object.entries(symbolCounts).filter(([_, count]) => count > 1);
    if (duplicates.length === 0) {
      console.log("✅ No duplicate open positions (KISS rule enforced)");
      validationsPassed++;
    } else {
      console.log(`❌ Found duplicate positions: ${duplicates.map(([sym, count]) => `${sym}:${count}`).join(", ")}`);
      validationsFailed++;
    }

    console.log("");
    console.log(`📊 Validations: ${validationsPassed} passed, ${validationsFailed} failed`);
    console.log("");

  } catch (error: any) {
    console.error("❌ Test failed:", error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run test
testAIFlow();
