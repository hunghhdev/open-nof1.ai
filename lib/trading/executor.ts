/**
 * Binance Trading Executor
 *
 * Executes AI trading decisions on Binance Futures
 * with safety guards and error handling
 */

import { binance } from "./binance";
import { prisma } from "../prisma";
import { Operation, Symbol, ExecutionStatus, PositionStatus } from "@prisma/client";

// DRY RUN MODE: If true, only log actions without executing on Binance
const DRY_RUN = process.env.DRY_RUN === "true";

// ============================================
// SAFETY LIMITS
// ============================================

const SAFETY_LIMITS = {
  MAX_LEVERAGE: 20,
  MIN_LEVERAGE: 1,
  MAX_POSITION_SIZE_PERCENTAGE: 0.6, // Max 60% of portfolio per position (adjusted for small accounts)
  MIN_CASH_RESERVE: 0.2, // 20% cash reserve (adjusted for small accounts)
  MAX_SLIPPAGE_PERCENTAGE: 0.02, // 2% max slippage from expected price
  MIN_TRADE_AMOUNT_USDT: 10, // Minimum $10 trade (Binance requirement)
};

// ============================================
// TYPES
// ============================================

interface BuyParams {
  symbol: Symbol;
  amount: number;
  leverage: number;
  stopLoss?: number;
  takeProfit?: number;
  tradeId: string;
}

interface SellParams {
  symbol: Symbol;
  percentage: number;
  tradeId: string;
}

interface UpdateSLTPParams {
  symbol: Symbol;
  stopLoss?: number;
  takeProfit?: number;
  tradeId: string;
}

interface ExecutionResult {
  success: boolean;
  orderId?: string;
  executedPrice?: number;
  executedAmount?: number;
  error?: string;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Convert Symbol enum to trading pair (e.g., BTC -> BTC/USDT)
 */
function symbolToPair(symbol: Symbol): string {
  return `${symbol}/USDT`;
}

/**
 * Check if position already exists for this symbol
 */
async function checkExistingPosition(symbol: Symbol): Promise<boolean> {
  const existingPosition = await prisma.position.findFirst({
    where: {
      symbol,
      status: PositionStatus.OPEN,
    },
  });
  return existingPosition !== null;
}

/**
 * Get current open position for symbol
 */
async function getOpenPosition(symbol: Symbol) {
  return await prisma.position.findFirst({
    where: {
      symbol,
      status: PositionStatus.OPEN,
    },
  });
}

/**
 * Validate cash availability
 */
async function validateCashAvailability(requiredAmount: number): Promise<boolean> {
  const balance = await binance.fetchBalance({ type: "future" });
  const availableCash = balance.USDT?.free || 0;

  // Require 30% cash reserve (from KISS prompt)
  const totalCash = balance.USDT?.total || 0;
  const minReserve = totalCash * SAFETY_LIMITS.MIN_CASH_RESERVE;

  return availableCash - requiredAmount >= minReserve;
}

/**
 * Validate leverage is within safe limits
 */
function validateLeverage(leverage: number): { valid: boolean; error?: string } {
  if (leverage < SAFETY_LIMITS.MIN_LEVERAGE || leverage > SAFETY_LIMITS.MAX_LEVERAGE) {
    return {
      valid: false,
      error: `Leverage must be between ${SAFETY_LIMITS.MIN_LEVERAGE}x and ${SAFETY_LIMITS.MAX_LEVERAGE}x`,
    };
  }
  return { valid: true };
}

/**
 * Validate position size doesn't exceed portfolio limit
 */
async function validatePositionSize(requiredCash: number): Promise<{ valid: boolean; error?: string }> {
  const balance = await binance.fetchBalance({ type: "future" });
  const totalCash = balance.USDT?.total || 0;

  const positionPercentage = requiredCash / totalCash;
  if (positionPercentage > SAFETY_LIMITS.MAX_POSITION_SIZE_PERCENTAGE) {
    return {
      valid: false,
      error: `Position size ${(positionPercentage * 100).toFixed(1)}% exceeds maximum ${SAFETY_LIMITS.MAX_POSITION_SIZE_PERCENTAGE * 100}%`,
    };
  }
  return { valid: true };
}

/**
 * Validate trade meets minimum size requirements
 */
async function validateMinTradeSize(symbol: Symbol, amount: number): Promise<{ valid: boolean; error?: string }> {
  const ticker = await binance.fetchTicker(symbolToPair(symbol));
  const currentPrice = ticker.last || 0;
  const tradeValueUSDT = amount * currentPrice;

  if (tradeValueUSDT < SAFETY_LIMITS.MIN_TRADE_AMOUNT_USDT) {
    return {
      valid: false,
      error: `Trade value $${tradeValueUSDT.toFixed(2)} is below minimum $${SAFETY_LIMITS.MIN_TRADE_AMOUNT_USDT}`,
    };
  }
  return { valid: true };
}

/**
 * Validate Stop-Loss and Take-Profit prices are logical
 */
function validateSLTP(
  entryPrice: number,
  stopLoss?: number,
  takeProfit?: number
): { valid: boolean; error?: string } {
  // For LONG positions (we only do LONG in futures)
  if (stopLoss && stopLoss >= entryPrice) {
    return {
      valid: false,
      error: `Stop-Loss $${stopLoss} must be below entry price $${entryPrice}`,
    };
  }

  if (takeProfit && takeProfit <= entryPrice) {
    return {
      valid: false,
      error: `Take-Profit $${takeProfit} must be above entry price $${entryPrice}`,
    };
  }

  return { valid: true };
}

// ============================================
// EXECUTION FUNCTIONS
// ============================================

/**
 * Execute BUY operation
 */
export async function executeBuy(params: BuyParams): Promise<ExecutionResult> {
  const { symbol, amount, leverage, stopLoss, takeProfit, tradeId } = params;

  console.log(`[EXECUTOR] 🔵 Starting BUY execution for ${symbol}`, {
    amount,
    leverage,
    stopLoss,
    takeProfit,
    tradeId,
  });

  try {
    // Update trade status to EXECUTING
    console.log(`[EXECUTOR] → Setting trade ${tradeId} to EXECUTING`);
    await prisma.trade.update({
      where: { id: tradeId },
      data: { status: ExecutionStatus.EXECUTING },
    });

    // Safety Guard 1: Check existing position
    console.log(`[EXECUTOR] → Safety Guard 1: Checking existing position for ${symbol}`);
    const hasPosition = await checkExistingPosition(symbol);
    if (hasPosition) {
      const error = `Position already exists for ${symbol}. Cannot open new position (KISS: 1 position per coin)`;
      console.log(`[EXECUTOR] ❌ Safety Guard 1 FAILED: ${error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error },
      });
      return { success: false, error };
    }
    console.log(`[EXECUTOR] ✓ Safety Guard 1 PASSED: No existing position`);

    // Safety Guard 2: Validate leverage
    console.log(`[EXECUTOR] → Safety Guard 2: Validating leverage ${leverage}x`);
    const leverageCheck = validateLeverage(leverage);
    if (!leverageCheck.valid) {
      console.log(`[EXECUTOR] ❌ Safety Guard 2 FAILED: ${leverageCheck.error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error: leverageCheck.error },
      });
      return { success: false, error: leverageCheck.error };
    }
    console.log(`[EXECUTOR] ✓ Safety Guard 2 PASSED: Leverage valid`);

    // Safety Guard 3: Validate minimum trade size
    console.log(`[EXECUTOR] → Safety Guard 3: Validating minimum trade size`);
    const minSizeCheck = await validateMinTradeSize(symbol, amount);
    if (!minSizeCheck.valid) {
      console.log(`[EXECUTOR] ❌ Safety Guard 3 FAILED: ${minSizeCheck.error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error: minSizeCheck.error },
      });
      return { success: false, error: minSizeCheck.error };
    }
    console.log(`[EXECUTOR] ✓ Safety Guard 3 PASSED: Trade size valid`);

    // Safety Guard 4: Calculate required cash and validate
    console.log(`[EXECUTOR] → Safety Guard 4: Fetching current price for ${symbol}`);
    const currentPrice = (await binance.fetchTicker(symbolToPair(symbol))).last!;
    const requiredCash = (amount * currentPrice) / leverage;
    console.log(`[EXECUTOR] → Current price: $${currentPrice}, Required cash: $${requiredCash.toFixed(2)}`);

    // Safety Guard 5: Validate position size
    console.log(`[EXECUTOR] → Safety Guard 5: Validating position size`);
    const positionSizeCheck = await validatePositionSize(requiredCash);
    if (!positionSizeCheck.valid) {
      console.log(`[EXECUTOR] ❌ Safety Guard 5 FAILED: ${positionSizeCheck.error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error: positionSizeCheck.error },
      });
      return { success: false, error: positionSizeCheck.error };
    }
    console.log(`[EXECUTOR] ✓ Safety Guard 5 PASSED: Position size within limit`);

    // Safety Guard 6: Validate cash availability (30% reserve)
    console.log(`[EXECUTOR] → Safety Guard 6: Validating cash availability (30% reserve)`);
    const hasEnoughCash = await validateCashAvailability(requiredCash);
    if (!hasEnoughCash) {
      const error = `Insufficient cash. Required: $${requiredCash.toFixed(2)} (must maintain 30% reserve)`;
      console.log(`[EXECUTOR] ❌ Safety Guard 6 FAILED: ${error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error },
      });
      return { success: false, error };
    }
    console.log(`[EXECUTOR] ✓ Safety Guard 6 PASSED: Sufficient cash available`);

    // Safety Guard 7: Validate SL/TP prices
    console.log(`[EXECUTOR] → Safety Guard 7: Validating SL/TP prices`);
    const sltpCheck = validateSLTP(currentPrice, stopLoss, takeProfit);
    if (!sltpCheck.valid) {
      console.log(`[EXECUTOR] ❌ Safety Guard 7 FAILED: ${sltpCheck.error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error: sltpCheck.error },
      });
      return { success: false, error: sltpCheck.error };
    }
    console.log(`[EXECUTOR] ✓ Safety Guard 7 PASSED: SL/TP prices valid`);
    console.log(`[EXECUTOR] ✅ All safety guards passed!`);


    // DRY RUN: Simulate execution
    if (DRY_RUN) {
      console.log(`[EXECUTOR] 🧪 DRY_RUN MODE: Simulating execution`);
      const simulatedOrder = {
        id: `DRY_RUN_${Date.now()}`,
        average: currentPrice,
        filled: amount,
      };

      console.log(`[DRY_RUN] 🔵 Would execute BUY:`, {
        symbol,
        amount,
        leverage,
        estimatedPrice: currentPrice,
        stopLoss,
        takeProfit,
      });

      // Create Position record
      console.log(`[EXECUTOR] → Creating Position record in database`);
      const position = await prisma.position.create({
        data: {
          symbol,
          status: PositionStatus.OPEN,
          entryPrice: simulatedOrder.average,
          entryAmount: simulatedOrder.filled,
          entryLeverage: leverage,
          entryOrderId: simulatedOrder.id,
          currentStopLoss: stopLoss,
          currentTakeProfit: takeProfit,
        },
      });

      await prisma.trade.update({
        where: { id: tradeId },
        data: {
          status: ExecutionStatus.FILLED,
          binanceOrderId: simulatedOrder.id,
          executedPrice: simulatedOrder.average,
          executedAmount: simulatedOrder.filled,
          executedAt: new Date(),
          positionId: position.id,
        },
      });

      console.log(`[EXECUTOR] ✅ BUY execution completed (DRY_RUN)`);
      return {
        success: true,
        orderId: simulatedOrder.id,
        executedPrice: simulatedOrder.average,
        executedAmount: simulatedOrder.filled,
      };
    }

    // REAL EXECUTION
    console.log(`[EXECUTOR] 🚀 LIVE MODE: Executing REAL BUY order on Binance`);
    // Set leverage
    console.log(`[EXECUTOR] → Setting leverage to ${leverage}x`);
    await binance.setLeverage(leverage, symbolToPair(symbol));

    // Create market order
    const order = await binance.createMarketOrder(
      symbolToPair(symbol),
      "buy",
      amount,
      undefined,
      { reduceOnly: false }
    );

    console.log(`[EXECUTOR] ✅ Buy order created:`, {
      symbol,
      orderId: order.id,
      price: order.average,
      amount: order.filled,
    });

    // Create Position record
    const position = await prisma.position.create({
      data: {
        symbol,
        status: PositionStatus.OPEN,
        entryPrice: order.average!,
        entryAmount: order.filled!,
        entryLeverage: leverage,
        entryOrderId: order.id,
        currentStopLoss: stopLoss,
        currentTakeProfit: takeProfit,
      },
    });

    // Update trade record
    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        status: ExecutionStatus.FILLED,
        binanceOrderId: order.id,
        executedPrice: order.average,
        executedAmount: order.filled,
        executedAt: new Date(),
        positionId: position.id,
      },
    });

    // Set Stop-Loss and Take-Profit if provided
    if (stopLoss || takeProfit) {
      await setStopLossTakeProfit(symbolToPair(symbol), stopLoss, takeProfit);
    }

    return {
      success: true,
      orderId: order.id,
      executedPrice: order.average,
      executedAmount: order.filled,
    };
  } catch (error: any) {
    console.error(`[EXECUTOR] Buy failed:`, error);

    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        status: ExecutionStatus.FAILED,
        error: error.message || "Unknown error",
      },
    });

    return { success: false, error: error.message };
  }
}

/**
 * Execute SELL operation
 */
export async function executeSell(params: SellParams): Promise<ExecutionResult> {
  const { symbol, percentage, tradeId } = params;

  console.log(`[EXECUTOR] 🔴 Starting SELL execution for ${symbol}`, {
    percentage,
    tradeId,
  });

  try {
    // Update trade status
    console.log(`[EXECUTOR] → Setting trade ${tradeId} to EXECUTING`);
    await prisma.trade.update({
      where: { id: tradeId },
      data: { status: ExecutionStatus.EXECUTING },
    });

    // Get open position
    console.log(`[EXECUTOR] → Fetching open position for ${symbol}`);
    const position = await getOpenPosition(symbol);
    if (!position) {
      const error = `No open position found for ${symbol}`;
      console.log(`[EXECUTOR] ❌ SELL FAILED: ${error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error },
      });
      return { success: false, error };
    }
    console.log(`[EXECUTOR] ✓ Found open position:`, {
      entryPrice: position.entryPrice,
      entryAmount: position.entryAmount,
      leverage: position.entryLeverage,
    });

    // Calculate amount to sell (KISS: always 100%)
    const amountToSell = (position.entryAmount * percentage) / 100;
    console.log(`[EXECUTOR] → Calculated sell amount: ${amountToSell} ${symbol} (${percentage}%)`);

    // DRY RUN: Simulate execution
    if (DRY_RUN) {
      console.log(`[EXECUTOR] 🧪 DRY_RUN MODE: Simulating SELL execution`);
      const currentPrice = (await binance.fetchTicker(symbolToPair(symbol))).last!;
      const simulatedOrder = {
        id: `DRY_RUN_${Date.now()}`,
        average: currentPrice,
        filled: amountToSell,
      };

      const realizedPnl =
        (simulatedOrder.average - position.entryPrice) *
        simulatedOrder.filled *
        position.entryLeverage;

      console.log(`[DRY_RUN] 🔴 Would execute SELL:`, {
        symbol,
        amount: amountToSell,
        estimatedPrice: currentPrice,
        estimatedPnL: `${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}`,
      });

      await prisma.position.update({
        where: { id: position.id },
        data: {
          status: PositionStatus.CLOSED,
          exitPrice: simulatedOrder.average,
          exitAmount: simulatedOrder.filled,
          exitOrderId: simulatedOrder.id,
          exitReason: "MANUAL",
          realizedPnl,
          closedAt: new Date(),
        },
      });

      await prisma.trade.update({
        where: { id: tradeId },
        data: {
          status: ExecutionStatus.FILLED,
          binanceOrderId: simulatedOrder.id,
          executedPrice: simulatedOrder.average,
          executedAmount: simulatedOrder.filled,
          executedAt: new Date(),
          positionId: position.id,
        },
      });

      return {
        success: true,
        orderId: simulatedOrder.id,
        executedPrice: simulatedOrder.average,
        executedAmount: simulatedOrder.filled,
      };
    }

    // REAL EXECUTION
    // Create market sell order
    const order = await binance.createMarketOrder(
      symbolToPair(symbol),
      "sell",
      amountToSell,
      undefined,
      { reduceOnly: true }
    );

    console.log(`[EXECUTOR] ✅ Sell order created:`, {
      symbol,
      orderId: order.id,
      price: order.average,
      amount: order.filled,
    });

    // Calculate P&L
    const realizedPnl =
      (order.average! - position.entryPrice) *
      order.filled! *
      position.entryLeverage;

    // Close position
    await prisma.position.update({
      where: { id: position.id },
      data: {
        status: PositionStatus.CLOSED,
        exitPrice: order.average,
        exitAmount: order.filled,
        exitOrderId: order.id,
        exitReason: "MANUAL",
        realizedPnl,
        closedAt: new Date(),
      },
    });

    // Update trade
    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        status: ExecutionStatus.FILLED,
        binanceOrderId: order.id,
        executedPrice: order.average,
        executedAmount: order.filled,
        executedAt: new Date(),
        positionId: position.id,
      },
    });

    return {
      success: true,
      orderId: order.id,
      executedPrice: order.average,
      executedAmount: order.filled,
    };
  } catch (error: any) {
    console.error(`[EXECUTOR] Sell failed:`, error);

    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        status: ExecutionStatus.FAILED,
        error: error.message || "Unknown error",
      },
    });

    return { success: false, error: error.message };
  }
}

/**
 * Update Stop-Loss and Take-Profit (for HOLD operation)
 */
export async function updateStopLossTakeProfit(
  params: UpdateSLTPParams
): Promise<ExecutionResult> {
  const { symbol, stopLoss, takeProfit, tradeId } = params;

  console.log(`[EXECUTOR] 🟡 Starting SL/TP UPDATE for ${symbol}`, {
    stopLoss,
    takeProfit,
    tradeId,
  });

  try {
    // Update trade status
    console.log(`[EXECUTOR] → Setting trade ${tradeId} to EXECUTING`);
    await prisma.trade.update({
      where: { id: tradeId },
      data: { status: ExecutionStatus.EXECUTING },
    });

    // Get open position
    console.log(`[EXECUTOR] → Fetching open position for ${symbol}`);
    const position = await getOpenPosition(symbol);
    if (!position) {
      const error = `No open position found for ${symbol}`;
      console.log(`[EXECUTOR] ❌ SL/TP UPDATE FAILED: ${error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error },
      });
      return { success: false, error };
    }
    console.log(`[EXECUTOR] ✓ Found open position:`, {
      currentSL: position.currentStopLoss,
      currentTP: position.currentTakeProfit,
    });

    // DRY RUN: Simulate update
    if (DRY_RUN) {
      console.log(`[EXECUTOR] 🧪 DRY_RUN MODE: Simulating SL/TP update`);
      console.log(`[DRY_RUN] 🟡 Would update SL/TP for ${symbol}:`, {
        stopLoss,
        takeProfit,
      });

      await prisma.position.update({
        where: { id: position.id },
        data: {
          currentStopLoss: stopLoss ?? position.currentStopLoss,
          currentTakeProfit: takeProfit ?? position.currentTakeProfit,
        },
      });

      await prisma.trade.update({
        where: { id: tradeId },
        data: {
          status: ExecutionStatus.FILLED,
          executedAt: new Date(),
          positionId: position.id,
        },
      });

      return { success: true };
    }

    // REAL EXECUTION
    // Update SL/TP on Binance
    await setStopLossTakeProfit(symbolToPair(symbol), stopLoss, takeProfit);

    // Update position record
    await prisma.position.update({
      where: { id: position.id },
      data: {
        currentStopLoss: stopLoss ?? position.currentStopLoss,
        currentTakeProfit: takeProfit ?? position.currentTakeProfit,
      },
    });

    // Update trade
    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        status: ExecutionStatus.FILLED,
        executedAt: new Date(),
        positionId: position.id,
      },
    });

    console.log(`[EXECUTOR] ✅ Updated SL/TP for ${symbol}:`, {
      stopLoss,
      takeProfit,
    });

    return { success: true };
  } catch (error: any) {
    console.error(`[EXECUTOR] Update SL/TP failed:`, error);

    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        status: ExecutionStatus.FAILED,
        error: error.message || "Unknown error",
      },
    });

    return { success: false, error: error.message };
  }
}

/**
 * Helper: Set Stop-Loss and Take-Profit on Binance
 */
async function setStopLossTakeProfit(
  pair: string,
  stopLoss?: number,
  takeProfit?: number
) {
  // Cancel existing SL/TP orders first
  const openOrders = await binance.fetchOpenOrders(pair);
  for (const order of openOrders) {
    if (order.type === "STOP_MARKET" || order.type === "TAKE_PROFIT_MARKET") {
      await binance.cancelOrder(order.id, pair);
    }
  }

  // Set new Stop-Loss
  if (stopLoss) {
    await binance.createOrder(pair, "STOP_MARKET", "sell", undefined, undefined, {
      stopPrice: stopLoss,
      reduceOnly: true,
    });
  }

  // Set new Take-Profit
  if (takeProfit) {
    await binance.createOrder(
      pair,
      "TAKE_PROFIT_MARKET",
      "sell",
      undefined,
      undefined,
      {
        stopPrice: takeProfit,
        reduceOnly: true,
      }
    );
  }
}
