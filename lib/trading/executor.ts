/**
 * Binance Trading Executor
 *
 * Executes AI trading decisions on Binance Futures
 * with safety guards and error handling
 */

import { binance } from "./binance";
import { prisma } from "../prisma";
import { Symbol, ExecutionStatus, PositionStatus } from "@prisma/client";

// DRY RUN MODE: If true, only log actions without executing on Binance
const DRY_RUN = process.env.DRY_RUN === "true";

// ============================================
// SAFETY LIMITS
// ============================================

const SAFETY_LIMITS = {
  MAX_LEVERAGE: 20,
  MIN_LEVERAGE: 1,
  MAX_POSITION_SIZE_PERCENTAGE: 0.5, // Max 50% of portfolio per position
  MIN_CASH_RESERVE: 0.25, // 25% cash reserve
  MAX_SLIPPAGE_PERCENTAGE: 0.015, // 1.5% max slippage from expected price
  MIN_TRADE_AMOUNT_USDT: 10, // Minimum $10 trade (Binance requirement)
  // New limits for profit optimization
  MAX_PORTFOLIO_LEVERAGE: 5, // Total notional / equity
  MAX_DAILY_LOSS_PERCENTAGE: 0.05, // 5% max daily loss
  MAX_WEEKLY_LOSS_PERCENTAGE: 0.10, // 10% max weekly loss
  MIN_RISK_REWARD_RATIO: 1.5, // Minimum R:R to accept trade
  MAX_RISK_PERCENTAGE: 0.03, // 3% max risk per trade
  LIQUIDATION_BUFFER: 0.15, // 15% buffer from liquidation price
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

/**
 * Validate total portfolio leverage across all positions
 */
async function validatePortfolioLeverage(newPositionNotional: number): Promise<{ valid: boolean; error?: string }> {
  const balance = await binance.fetchBalance({ type: "future" });
  const equity = balance.USDT?.total || 0;

  if (equity === 0) {
    return { valid: false, error: "No equity available" };
  }

  const positions = await binance.fetchPositions();
  const currentNotional = positions.reduce((sum, p) => sum + Math.abs(p.notional || 0), 0);

  const totalNotional = currentNotional + newPositionNotional;
  const portfolioLeverage = totalNotional / equity;

  if (portfolioLeverage > SAFETY_LIMITS.MAX_PORTFOLIO_LEVERAGE) {
    return {
      valid: false,
      error: `Portfolio leverage ${portfolioLeverage.toFixed(1)}x exceeds max ${SAFETY_LIMITS.MAX_PORTFOLIO_LEVERAGE}x`,
    };
  }
  return { valid: true };
}

/**
 * Validate risk percentage based on stop loss distance
 */
function validateRiskPercentage(
  equity: number,
  entryPrice: number,
  stopLoss: number | undefined,
  amount: number,
  leverage: number
): { valid: boolean; actualRisk: number; error?: string } {
  if (!stopLoss) {
    return { valid: true, actualRisk: 0 }; // No SL means we can't calculate risk
  }

  const stopDistance = Math.abs(entryPrice - stopLoss);
  const potentialLoss = stopDistance * amount * leverage;
  const actualRisk = potentialLoss / equity;

  if (actualRisk > SAFETY_LIMITS.MAX_RISK_PERCENTAGE) {
    return {
      valid: false,
      actualRisk,
      error: `Risk ${(actualRisk * 100).toFixed(1)}% exceeds max ${SAFETY_LIMITS.MAX_RISK_PERCENTAGE * 100}%`,
    };
  }
  return { valid: true, actualRisk };
}

/**
 * Validate risk/reward ratio
 */
function validateRiskRewardRatio(
  entryPrice: number,
  stopLoss?: number,
  takeProfit?: number
): { valid: boolean; ratio: number; error?: string } {
  if (!stopLoss || !takeProfit) {
    return { valid: true, ratio: 0 }; // Can't calculate without both
  }

  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(takeProfit - entryPrice);
  const ratio = reward / risk;

  if (ratio < SAFETY_LIMITS.MIN_RISK_REWARD_RATIO) {
    return {
      valid: false,
      ratio,
      error: `Risk/Reward ratio ${ratio.toFixed(2)} below minimum ${SAFETY_LIMITS.MIN_RISK_REWARD_RATIO}`,
    };
  }
  return { valid: true, ratio };
}

/**
 * Calculate liquidation price and validate buffer
 */
function validateLiquidationBuffer(
  entryPrice: number,
  leverage: number,
  stopLoss?: number
): { liquidationPrice: number; buffer: number; valid: boolean; error?: string } {
  // Simplified liquidation formula for LONG positions
  // For LONG: Liq = Entry × (1 - 1/Leverage + maintenanceMargin)
  const maintenanceMargin = 0.004; // 0.4% for most pairs
  const liquidationPrice = entryPrice * (1 - (1 / leverage) + maintenanceMargin);

  const bufferFromEntry = (entryPrice - liquidationPrice) / entryPrice;

  // If SL is set, check it's above liquidation price
  if (stopLoss && stopLoss <= liquidationPrice) {
    return {
      liquidationPrice,
      buffer: bufferFromEntry,
      valid: false,
      error: `Stop-Loss $${stopLoss.toFixed(2)} is at or below liquidation price $${liquidationPrice.toFixed(2)}`,
    };
  }

  if (bufferFromEntry < SAFETY_LIMITS.LIQUIDATION_BUFFER) {
    return {
      liquidationPrice,
      buffer: bufferFromEntry,
      valid: false,
      error: `Liquidation buffer ${(bufferFromEntry * 100).toFixed(1)}% below minimum ${SAFETY_LIMITS.LIQUIDATION_BUFFER * 100}%`,
    };
  }

  return { liquidationPrice, buffer: bufferFromEntry, valid: true };
}

/**
 * Check daily and weekly loss limits
 */
async function checkLossLimits(equity: number): Promise<{ canTrade: boolean; reason?: string }> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const [dailyTrades, weeklyTrades] = await Promise.all([
    prisma.position.findMany({
      where: {
        closedAt: { gte: startOfDay },
        status: "CLOSED",
      },
    }),
    prisma.position.findMany({
      where: {
        closedAt: { gte: startOfWeek },
        status: "CLOSED",
      },
    }),
  ]);

  const dailyPnl = dailyTrades.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
  const weeklyPnl = weeklyTrades.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);

  if (dailyPnl < -equity * SAFETY_LIMITS.MAX_DAILY_LOSS_PERCENTAGE) {
    return { canTrade: false, reason: `Daily loss limit hit: $${dailyPnl.toFixed(2)} (max: -$${(equity * SAFETY_LIMITS.MAX_DAILY_LOSS_PERCENTAGE).toFixed(2)})` };
  }

  if (weeklyPnl < -equity * SAFETY_LIMITS.MAX_WEEKLY_LOSS_PERCENTAGE) {
    return { canTrade: false, reason: `Weekly loss limit hit: $${weeklyPnl.toFixed(2)} (max: -$${(equity * SAFETY_LIMITS.MAX_WEEKLY_LOSS_PERCENTAGE).toFixed(2)})` };
  }

  return { canTrade: true };
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

    // Safety Guard 8: Check daily/weekly loss limits
    const balance = await binance.fetchBalance({ type: "future" });
    const equity = balance.USDT?.total || 0;
    console.log(`[EXECUTOR] → Safety Guard 8: Checking daily/weekly loss limits`);
    const lossLimitCheck = await checkLossLimits(equity);
    if (!lossLimitCheck.canTrade) {
      console.log(`[EXECUTOR] ❌ Safety Guard 8 FAILED: ${lossLimitCheck.reason}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error: lossLimitCheck.reason },
      });
      return { success: false, error: lossLimitCheck.reason };
    }
    console.log(`[EXECUTOR] ✓ Safety Guard 8 PASSED: Loss limits OK`);

    // Safety Guard 9: Validate portfolio leverage
    const positionNotional = amount * currentPrice;
    console.log(`[EXECUTOR] → Safety Guard 9: Validating portfolio leverage`);
    const portfolioLeverageCheck = await validatePortfolioLeverage(positionNotional);
    if (!portfolioLeverageCheck.valid) {
      console.log(`[EXECUTOR] ❌ Safety Guard 9 FAILED: ${portfolioLeverageCheck.error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error: portfolioLeverageCheck.error },
      });
      return { success: false, error: portfolioLeverageCheck.error };
    }
    console.log(`[EXECUTOR] ✓ Safety Guard 9 PASSED: Portfolio leverage OK`);

    // Safety Guard 10: Validate risk percentage
    console.log(`[EXECUTOR] → Safety Guard 10: Validating risk percentage`);
    const riskCheck = validateRiskPercentage(equity, currentPrice, stopLoss, amount, leverage);
    if (!riskCheck.valid) {
      console.log(`[EXECUTOR] ❌ Safety Guard 10 FAILED: ${riskCheck.error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error: riskCheck.error },
      });
      return { success: false, error: riskCheck.error };
    }
    console.log(`[EXECUTOR] ✓ Safety Guard 10 PASSED: Risk ${(riskCheck.actualRisk * 100).toFixed(1)}%`);

    // Safety Guard 11: Validate risk/reward ratio
    console.log(`[EXECUTOR] → Safety Guard 11: Validating risk/reward ratio`);
    const rrCheck = validateRiskRewardRatio(currentPrice, stopLoss, takeProfit);
    if (!rrCheck.valid) {
      console.log(`[EXECUTOR] ❌ Safety Guard 11 FAILED: ${rrCheck.error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error: rrCheck.error },
      });
      return { success: false, error: rrCheck.error };
    }
    if (rrCheck.ratio > 0) {
      console.log(`[EXECUTOR] ✓ Safety Guard 11 PASSED: R:R ratio ${rrCheck.ratio.toFixed(2)}`);
    } else {
      console.log(`[EXECUTOR] ⚠ Safety Guard 11 SKIPPED: No SL/TP provided`);
    }

    // Safety Guard 12: Validate liquidation buffer
    console.log(`[EXECUTOR] → Safety Guard 12: Validating liquidation buffer`);
    const liqCheck = validateLiquidationBuffer(currentPrice, leverage, stopLoss);
    if (!liqCheck.valid) {
      console.log(`[EXECUTOR] ❌ Safety Guard 12 FAILED: ${liqCheck.error}`);
      await prisma.trade.update({
        where: { id: tradeId },
        data: { status: ExecutionStatus.FAILED, error: liqCheck.error },
      });
      return { success: false, error: liqCheck.error };
    }
    console.log(`[EXECUTOR] ✓ Safety Guard 12 PASSED: Liquidation price $${liqCheck.liquidationPrice.toFixed(2)}, buffer ${(liqCheck.buffer * 100).toFixed(1)}%`);

    console.log(`[EXECUTOR] ✅ All 12 safety guards passed!`);

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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[EXECUTOR] Buy failed:`, error);

    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        status: ExecutionStatus.FAILED,
        error: errorMessage,
      },
    });

    return { success: false, error: errorMessage };
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

    // Check if this is a partial sell
    const isPartialSell = percentage < 100;
    const remainingAmount = position.entryAmount - amountToSell;

    console.log(`[EXECUTOR] → Sell type: ${isPartialSell ? "PARTIAL" : "FULL"} (${percentage}%)`);
    if (isPartialSell) {
      console.log(`[EXECUTOR] → Remaining amount after sell: ${remainingAmount} ${symbol}`);
    }

    // DRY RUN: Simulate execution
    if (DRY_RUN) {
      console.log(`[EXECUTOR] 🧪 DRY_RUN MODE: Simulating ${isPartialSell ? "PARTIAL" : "FULL"} SELL execution`);
      const currentPrice = (await binance.fetchTicker(symbolToPair(symbol))).last!;
      const simulatedOrder = {
        id: `DRY_RUN_${Date.now()}`,
        average: currentPrice,
        filled: amountToSell,
      };

      const partialPnl =
        (simulatedOrder.average - position.entryPrice) *
        simulatedOrder.filled *
        position.entryLeverage;

      console.log(`[DRY_RUN] 🔴 Would execute ${isPartialSell ? "PARTIAL" : "FULL"} SELL:`, {
        symbol,
        amount: amountToSell,
        percentage,
        estimatedPrice: currentPrice,
        estimatedPnL: `${partialPnl >= 0 ? "+" : ""}$${partialPnl.toFixed(2)}`,
        remainingAmount: isPartialSell ? remainingAmount : 0,
      });

      if (isPartialSell) {
        // PARTIAL SELL: Update position with remaining amount
        await prisma.position.update({
          where: { id: position.id },
          data: {
            entryAmount: remainingAmount,
            realizedPnl: (position.realizedPnl || 0) + partialPnl,
          },
        });
        console.log(`[EXECUTOR] → Position updated: ${remainingAmount} ${symbol} remaining, +$${partialPnl.toFixed(2)} realized`);
      } else {
        // FULL SELL: Close position
        await prisma.position.update({
          where: { id: position.id },
          data: {
            status: PositionStatus.CLOSED,
            exitPrice: simulatedOrder.average,
            exitAmount: simulatedOrder.filled,
            exitOrderId: simulatedOrder.id,
            exitReason: "MANUAL",
            realizedPnl: (position.realizedPnl || 0) + partialPnl,
            closedAt: new Date(),
          },
        });
      }

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

    console.log(`[EXECUTOR] ✅ ${isPartialSell ? "Partial" : "Full"} sell order created:`, {
      symbol,
      orderId: order.id,
      price: order.average,
      amount: order.filled,
      percentage,
    });

    // Calculate P&L for this sell
    const partialPnl =
      (order.average! - position.entryPrice) *
      order.filled! *
      position.entryLeverage;

    if (isPartialSell) {
      // PARTIAL SELL: Update position with remaining amount
      await prisma.position.update({
        where: { id: position.id },
        data: {
          entryAmount: remainingAmount,
          realizedPnl: (position.realizedPnl || 0) + partialPnl,
        },
      });

      console.log(`[EXECUTOR] → Position updated after partial sell:`, {
        remainingAmount,
        totalRealizedPnl: (position.realizedPnl || 0) + partialPnl,
      });
    } else {
      // FULL SELL: Close position
      await prisma.position.update({
        where: { id: position.id },
        data: {
          status: PositionStatus.CLOSED,
          exitPrice: order.average,
          exitAmount: order.filled,
          exitOrderId: order.id,
          exitReason: "MANUAL",
          realizedPnl: (position.realizedPnl || 0) + partialPnl,
          closedAt: new Date(),
        },
      });
    }

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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[EXECUTOR] Sell failed:`, error);

    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        status: ExecutionStatus.FAILED,
        error: errorMessage,
      },
    });

    return { success: false, error: errorMessage };
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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[EXECUTOR] Update SL/TP failed:`, error);

    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        status: ExecutionStatus.FAILED,
        error: errorMessage,
      },
    });

    return { success: false, error: errorMessage };
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
