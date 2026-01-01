import { Position } from "ccxt";
import { binance } from "./binance";
import { prisma } from "../prisma";

// Trading mode thresholds based on account performance
const TRADING_MODE_THRESHOLDS = {
  SURVIVAL: { maxReturn: -0.10, maxRisk: 0.005, maxLeverage: 2, maxPositions: 1 },
  DEFENSIVE: { maxReturn: -0.05, maxRisk: 0.015, maxLeverage: 3, maxPositions: 2 },
  NORMAL: { maxReturn: 0.10, maxRisk: 0.02, maxLeverage: 5, maxPositions: 3 },
  OFFENSIVE: { maxReturn: 0.20, maxRisk: 0.025, maxLeverage: 7, maxPositions: 4 },
  AGGRESSIVE: { maxReturn: Infinity, maxRisk: 0.03, maxLeverage: 10, maxPositions: 5 },
};

export type TradingMode = keyof typeof TRADING_MODE_THRESHOLDS;

export interface PerformanceMetrics {
  winRate: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  maxDrawdown: number;
  currentDrawdown: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
}

export interface RiskMetrics {
  totalNotional: number;
  portfolioLeverage: number;
  marginUsedPercentage: number;
  availableMarginPercentage: number;
  liquidationRisk: "low" | "medium" | "high";
}

export interface AccountInformationAndPerformance {
  currentPositionsValue: number;
  contractValue: number;
  totalCashValue: number;
  availableCash: number;
  currentTotalReturn: number;
  positions: Position[];
  sharpeRatio: number;
  // New fields for profit optimization
  tradingMode: TradingMode;
  maxRiskPercentage: number;
  maxLeverage: number;
  maxPositions: number;
  performance: PerformanceMetrics;
  risk: RiskMetrics;
}

/**
 * Determine trading mode based on current return
 */
function determineTradingMode(currentReturn: number): {
  mode: TradingMode;
  maxRisk: number;
  maxLeverage: number;
  maxPositions: number;
} {
  if (currentReturn < TRADING_MODE_THRESHOLDS.SURVIVAL.maxReturn) {
    return {
      mode: "SURVIVAL",
      maxRisk: TRADING_MODE_THRESHOLDS.SURVIVAL.maxRisk,
      maxLeverage: TRADING_MODE_THRESHOLDS.SURVIVAL.maxLeverage,
      maxPositions: TRADING_MODE_THRESHOLDS.SURVIVAL.maxPositions,
    };
  }
  if (currentReturn < TRADING_MODE_THRESHOLDS.DEFENSIVE.maxReturn) {
    return {
      mode: "DEFENSIVE",
      maxRisk: TRADING_MODE_THRESHOLDS.DEFENSIVE.maxRisk,
      maxLeverage: TRADING_MODE_THRESHOLDS.DEFENSIVE.maxLeverage,
      maxPositions: TRADING_MODE_THRESHOLDS.DEFENSIVE.maxPositions,
    };
  }
  if (currentReturn < TRADING_MODE_THRESHOLDS.NORMAL.maxReturn) {
    return {
      mode: "NORMAL",
      maxRisk: TRADING_MODE_THRESHOLDS.NORMAL.maxRisk,
      maxLeverage: TRADING_MODE_THRESHOLDS.NORMAL.maxLeverage,
      maxPositions: TRADING_MODE_THRESHOLDS.NORMAL.maxPositions,
    };
  }
  if (currentReturn < TRADING_MODE_THRESHOLDS.OFFENSIVE.maxReturn) {
    return {
      mode: "OFFENSIVE",
      maxRisk: TRADING_MODE_THRESHOLDS.OFFENSIVE.maxRisk,
      maxLeverage: TRADING_MODE_THRESHOLDS.OFFENSIVE.maxLeverage,
      maxPositions: TRADING_MODE_THRESHOLDS.OFFENSIVE.maxPositions,
    };
  }
  return {
    mode: "AGGRESSIVE",
    maxRisk: TRADING_MODE_THRESHOLDS.AGGRESSIVE.maxRisk,
    maxLeverage: TRADING_MODE_THRESHOLDS.AGGRESSIVE.maxLeverage,
    maxPositions: TRADING_MODE_THRESHOLDS.AGGRESSIVE.maxPositions,
  };
}

/**
 * Calculate proper Sharpe ratio using historical returns
 */
async function calculateSharpeRatio(initialCapital: number): Promise<number> {
  const closedPositions = await prisma.position.findMany({
    where: { status: "CLOSED" },
    orderBy: { closedAt: "asc" },
  });

  if (closedPositions.length < 5) return 0; // Not enough data

  // Calculate returns for each trade
  const returns: number[] = [];
  let runningCapital = initialCapital;

  for (const pos of closedPositions) {
    const pnl = pos.realizedPnl || 0;
    if (runningCapital > 0) {
      const returnPct = pnl / runningCapital;
      returns.push(returnPct);
      runningCapital += pnl;
    }
  }

  if (returns.length < 5) return 0;

  // Sharpe = (Mean Return - Risk Free Rate) / StdDev of Returns
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const riskFreeRate = 0.0001; // ~3.65% annual, per trade basis

  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) /
    returns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualized Sharpe (assuming ~100 trades per year)
  const tradeSharpe = (meanReturn - riskFreeRate) / stdDev;
  const annualizedSharpe = tradeSharpe * Math.sqrt(100);

  return annualizedSharpe;
}

/**
 * Calculate performance metrics from historical trades
 */
async function calculatePerformanceMetrics(): Promise<PerformanceMetrics> {
  const closedPositions = await prisma.position.findMany({
    where: { status: "CLOSED" },
    orderBy: { closedAt: "asc" },
  });

  const wins = closedPositions.filter((p) => (p.realizedPnl || 0) > 0);
  const losses = closedPositions.filter((p) => (p.realizedPnl || 0) < 0);

  const totalWinAmount = wins.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
  const totalLossAmount = Math.abs(
    losses.reduce((sum, p) => sum + (p.realizedPnl || 0), 0)
  );

  // Calculate consecutive wins/losses
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;

  for (const pos of closedPositions) {
    const pnl = pos.realizedPnl || 0;
    if (pnl > 0) {
      currentWinStreak++;
      currentLossStreak = 0;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWinStreak);
    } else if (pnl < 0) {
      currentLossStreak++;
      currentWinStreak = 0;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLossStreak);
    }
  }

  // Calculate max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let runningPnl = 0;

  for (const pos of closedPositions) {
    runningPnl += pos.realizedPnl || 0;
    if (runningPnl > peak) {
      peak = runningPnl;
    }
    const drawdown = peak > 0 ? (peak - runningPnl) / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  // Current drawdown
  const currentDrawdown = peak > 0 ? (peak - runningPnl) / peak : 0;

  return {
    winRate:
      closedPositions.length > 0 ? wins.length / closedPositions.length : 0,
    profitFactor: totalLossAmount > 0 ? totalWinAmount / totalLossAmount : 0,
    averageWin: wins.length > 0 ? totalWinAmount / wins.length : 0,
    averageLoss: losses.length > 0 ? totalLossAmount / losses.length : 0,
    largestWin: wins.length > 0 ? Math.max(...wins.map((p) => p.realizedPnl || 0)) : 0,
    largestLoss: losses.length > 0 ? Math.abs(Math.min(...losses.map((p) => p.realizedPnl || 0))) : 0,
    consecutiveWins: maxConsecutiveWins,
    consecutiveLosses: maxConsecutiveLosses,
    maxDrawdown,
    currentDrawdown,
    totalTrades: closedPositions.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
  };
}

/**
 * Calculate risk metrics from current positions
 */
function calculateRiskMetrics(
  positions: Position[],
  totalCash: number
): RiskMetrics {
  const totalNotional = positions.reduce(
    (sum, p) => sum + Math.abs(p.notional || 0),
    0
  );
  const portfolioLeverage = totalCash > 0 ? totalNotional / totalCash : 0;

  const marginUsed = positions.reduce(
    (sum, p) => sum + (p.initialMargin || 0),
    0
  );
  const marginUsedPercentage = totalCash > 0 ? marginUsed / totalCash : 0;
  const availableMarginPercentage = 1 - marginUsedPercentage;

  // Determine liquidation risk level
  let liquidationRisk: "low" | "medium" | "high" = "low";
  if (portfolioLeverage > 3) liquidationRisk = "medium";
  if (portfolioLeverage > 5) liquidationRisk = "high";

  // Check if any position is close to liquidation
  for (const pos of positions) {
    if (pos.liquidationPrice && pos.markPrice && pos.entryPrice) {
      const distanceToLiq =
        Math.abs(pos.markPrice - pos.liquidationPrice) / pos.markPrice;
      if (distanceToLiq < 0.1) liquidationRisk = "high";
      else if (distanceToLiq < 0.2 && liquidationRisk !== "high")
        liquidationRisk = "medium";
    }
  }

  return {
    totalNotional,
    portfolioLeverage,
    marginUsedPercentage,
    availableMarginPercentage,
    liquidationRisk,
  };
}

export async function getAccountInformationAndPerformance(
  initialCapital: number
): Promise<AccountInformationAndPerformance> {
  // Fetch all trading symbols from environment
  const tradingSymbolsEnv = process.env.TRADING_SYMBOLS || "BTC/USDT";
  const tradingSymbols = tradingSymbolsEnv.split(",").map((s) => s.trim());

  const positions = await binance.fetchPositions(tradingSymbols);
  const currentPositionsValue = positions.reduce((acc, position) => {
    return acc + (position.initialMargin || 0) + (position.unrealizedPnl || 0);
  }, 0);
  const contractValue = positions.reduce((acc, position) => {
    return acc + (position.contracts || 0);
  }, 0);
  const currentCashValue = await binance.fetchBalance({ type: "future" });
  const totalCashValue = currentCashValue.USDT.total || 0;
  const availableCash = currentCashValue.USDT.free || 0;
  const currentTotalReturn =
    (totalCashValue - initialCapital) / initialCapital;

  // Calculate proper Sharpe ratio
  const sharpeRatio = await calculateSharpeRatio(initialCapital);

  // Determine trading mode based on performance
  const tradingModeInfo = determineTradingMode(currentTotalReturn);

  // Calculate performance metrics
  const performance = await calculatePerformanceMetrics();

  // Calculate risk metrics
  const risk = calculateRiskMetrics(positions, totalCashValue);

  return {
    currentPositionsValue,
    contractValue,
    totalCashValue,
    availableCash,
    currentTotalReturn,
    positions,
    sharpeRatio,
    tradingMode: tradingModeInfo.mode,
    maxRiskPercentage: tradingModeInfo.maxRisk,
    maxLeverage: tradingModeInfo.maxLeverage,
    maxPositions: tradingModeInfo.maxPositions,
    performance,
    risk,
  };
}

export function formatAccountPerformance(
  accountPerformance: AccountInformationAndPerformance
) {
  const {
    currentTotalReturn,
    availableCash,
    totalCashValue,
    positions,
    tradingMode,
    maxRiskPercentage,
    maxLeverage,
    maxPositions,
    sharpeRatio,
    performance,
    risk,
  } = accountPerformance;

  const output = `## Account Performance
Current Total Return: ${(currentTotalReturn * 100).toFixed(2)}%
Available Cash: $${availableCash.toFixed(2)}
Total Account Value: $${totalCashValue.toFixed(2)}
Sharpe Ratio: ${sharpeRatio.toFixed(2)}

## Trading Mode: ${tradingMode}
- Max Risk Per Trade: ${(maxRiskPercentage * 100).toFixed(1)}%
- Max Leverage: ${maxLeverage}x
- Max Positions: ${maxPositions}

## Performance Metrics
- Win Rate: ${(performance.winRate * 100).toFixed(1)}% (${performance.winningTrades}W / ${performance.losingTrades}L)
- Profit Factor: ${performance.profitFactor.toFixed(2)}
- Average Win: $${performance.averageWin.toFixed(2)}
- Average Loss: $${performance.averageLoss.toFixed(2)}
- Largest Win: $${performance.largestWin.toFixed(2)}
- Largest Loss: $${performance.largestLoss.toFixed(2)}
- Max Drawdown: ${(performance.maxDrawdown * 100).toFixed(1)}%
- Current Drawdown: ${(performance.currentDrawdown * 100).toFixed(1)}%

## Risk Status
- Portfolio Leverage: ${risk.portfolioLeverage.toFixed(2)}x
- Margin Used: ${(risk.marginUsedPercentage * 100).toFixed(1)}%
- Liquidation Risk: ${risk.liquidationRisk.toUpperCase()}

## Current Positions
${
  positions.length > 0
    ? positions
        .map((position) =>
          JSON.stringify(
            {
              symbol: position.symbol,
              quantity: position.contracts,
              entry_price: position.entryPrice,
              current_price: position.markPrice,
              liquidation_price: position.liquidationPrice,
              unrealized_pnl: position.unrealizedPnl,
              leverage: position.leverage,
              notional_usd: position.notional,
              side: position.side,
              stopLoss: position.stopLossPrice,
              takeProfit: position.takeProfitPrice,
            },
            null,
            2
          )
        )
        .join("\n")
    : "No open positions"
}`;
  return output;
}
