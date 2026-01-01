import { EMA, MACD, RSI, ATR, ADX, BollingerBands, StochasticRSI } from "technicalindicators";

// ============================================
// TYPES
// ============================================

export interface PivotPoints {
  pivot: number;
  r1: number;
  r2: number;
  s1: number;
  s2: number;
}

export interface BollingerBandsResult {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number; // (upper - lower) / middle - volatility measure
  percentB: number; // (price - lower) / (upper - lower) - position within bands
}

export interface StochRSIResult {
  stochRSI: number;
  k: number;
  d: number;
}

export interface Divergence {
  type: "bullish" | "bearish" | "hidden_bullish" | "hidden_bearish" | null;
  strength: number; // 0-1, based on price/RSI delta difference
}

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

// ============================================
// BASIC INDICATORS
// ============================================

/**
 * Calculate EMA (Exponential Moving Average)
 */
export function calculateEMA(values: number[], period: number): number[] {
  const emaValues = EMA.calculate({ values, period });
  return emaValues;
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
export function calculateMACD(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): number[] {
  const macdValues = MACD.calculate({
    values,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  return macdValues.map((v) => v.MACD || 0);
}

/**
 * Calculate MACD with full components (MACD line, Signal line, Histogram)
 */
export function calculateMACDFull(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MACDResult[] {
  const macdValues = MACD.calculate({
    values,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  return macdValues.map((v) => ({
    macd: v.MACD || 0,
    signal: v.signal || 0,
    histogram: v.histogram || 0,
  }));
}

/**
 * Calculate RSI (Relative Strength Index)
 */
export function calculateRSI(values: number[], period: number): number[] {
  const rsiValues = RSI.calculate({ values, period });
  return rsiValues;
}

/**
 * Calculate ATR (Average True Range)
 */
export function calculateATR(
  high: number[],
  low: number[],
  close: number[],
  period: number
): number[] {
  const atrValues = ATR.calculate({ high, low, close, period });
  return atrValues;
}

/**
 * Calculate ADX (Average Directional Index)
 */
export function calculateADX(
  high: number[],
  low: number[],
  close: number[],
  period: number
): number[] {
  const adxValues = ADX.calculate({ high, low, close, period });
  return adxValues.map((v) => v.adx);
}

/**
 * Calculate Standard Pivot Points
 * Uses the previous candle (High, Low, Close) to calculate levels for the current period
 */
export function calculatePivotPoints(
  high: number,
  low: number,
  close: number
): PivotPoints {
  const pivot = (high + low + close) / 3;
  const r1 = 2 * pivot - low;
  const s1 = 2 * pivot - high;
  const r2 = pivot + (high - low);
  const s2 = pivot - (high - low);

  return { pivot, r1, r2, s1, s2 };
}

// ============================================
// NEW INDICATORS FOR PROFIT OPTIMIZATION
// ============================================

/**
 * Calculate Bollinger Bands
 * Used for volatility regime detection and breakout signals
 */
export function calculateBollingerBands(
  values: number[],
  period: number = 20,
  stdDev: number = 2
): BollingerBandsResult[] {
  const bbValues = BollingerBands.calculate({
    values,
    period,
    stdDev,
  });

  return bbValues.map((bb, i) => {
    const currentPrice = values[values.length - bbValues.length + i];
    const bandwidth = bb.middle > 0 ? (bb.upper - bb.lower) / bb.middle : 0;
    const range = bb.upper - bb.lower;
    const percentB = range > 0 ? (currentPrice - bb.lower) / range : 0.5;

    return {
      upper: bb.upper,
      middle: bb.middle,
      lower: bb.lower,
      bandwidth,
      percentB,
    };
  });
}

/**
 * Calculate Stochastic RSI
 * Faster overbought/oversold detection than regular RSI
 */
export function calculateStochRSI(
  values: number[],
  rsiPeriod: number = 14,
  stochPeriod: number = 14,
  kPeriod: number = 3,
  dPeriod: number = 3
): StochRSIResult[] {
  const stochRSIValues = StochasticRSI.calculate({
    values,
    rsiPeriod,
    stochasticPeriod: stochPeriod,
    kPeriod,
    dPeriod,
  });

  return stochRSIValues.map((v) => ({
    stochRSI: v.stochRSI || 0,
    k: v.k || 0,
    d: v.d || 0,
  }));
}

/**
 * Detect RSI Divergence
 * Bullish: Price makes lower low, RSI makes higher low
 * Bearish: Price makes higher high, RSI makes lower high
 */
export function detectRSIDivergence(
  prices: number[],
  rsi: number[],
  lookback: number = 14
): Divergence {
  if (prices.length < lookback || rsi.length < lookback) {
    return { type: null, strength: 0 };
  }

  // Get recent data for analysis
  const recentPrices = prices.slice(-lookback);
  const recentRSI = rsi.slice(-lookback);

  // Find swing points (simplified approach)
  const priceMin1 = Math.min(...recentPrices.slice(0, Math.floor(lookback / 2)));
  const priceMin2 = Math.min(...recentPrices.slice(Math.floor(lookback / 2)));
  const priceMax1 = Math.max(...recentPrices.slice(0, Math.floor(lookback / 2)));
  const priceMax2 = Math.max(...recentPrices.slice(Math.floor(lookback / 2)));

  const rsiMin1 = Math.min(...recentRSI.slice(0, Math.floor(lookback / 2)));
  const rsiMin2 = Math.min(...recentRSI.slice(Math.floor(lookback / 2)));
  const rsiMax1 = Math.max(...recentRSI.slice(0, Math.floor(lookback / 2)));
  const rsiMax2 = Math.max(...recentRSI.slice(Math.floor(lookback / 2)));

  // Bullish divergence: Price lower low, RSI higher low
  if (priceMin2 < priceMin1 && rsiMin2 > rsiMin1) {
    const priceChange = (priceMin1 - priceMin2) / priceMin1;
    const rsiChange = (rsiMin2 - rsiMin1) / 100;
    const strength = Math.min(1, (priceChange + rsiChange) * 2);
    return { type: "bullish", strength };
  }

  // Bearish divergence: Price higher high, RSI lower high
  if (priceMax2 > priceMax1 && rsiMax2 < rsiMax1) {
    const priceChange = (priceMax2 - priceMax1) / priceMax1;
    const rsiChange = (rsiMax1 - rsiMax2) / 100;
    const strength = Math.min(1, (priceChange + rsiChange) * 2);
    return { type: "bearish", strength };
  }

  // Hidden bullish: Price higher low, RSI lower low (trend continuation)
  if (priceMin2 > priceMin1 && rsiMin2 < rsiMin1) {
    const strength = Math.min(1, Math.abs(rsiMin1 - rsiMin2) / 20);
    return { type: "hidden_bullish", strength };
  }

  // Hidden bearish: Price lower high, RSI higher high (trend continuation)
  if (priceMax2 < priceMax1 && rsiMax2 > rsiMax1) {
    const strength = Math.min(1, Math.abs(rsiMax2 - rsiMax1) / 20);
    return { type: "hidden_bearish", strength };
  }

  return { type: null, strength: 0 };
}

/**
 * Calculate VWAP (Volume Weighted Average Price)
 * Important institutional reference level
 */
export function calculateVWAP(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[]
): number[] {
  if (
    highs.length !== lows.length ||
    lows.length !== closes.length ||
    closes.length !== volumes.length
  ) {
    return [];
  }

  const vwap: number[] = [];
  let cumulativeTPV = 0; // Typical Price × Volume
  let cumulativeVolume = 0;

  for (let i = 0; i < closes.length; i++) {
    const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
    cumulativeTPV += typicalPrice * volumes[i];
    cumulativeVolume += volumes[i];

    vwap.push(cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice);
  }

  return vwap;
}

/**
 * Calculate OBV (On-Balance Volume)
 * Detects volume momentum that precedes price moves
 */
export function calculateOBV(closes: number[], volumes: number[]): number[] {
  if (closes.length !== volumes.length || closes.length < 2) {
    return [];
  }

  const obv: number[] = [0];

  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      obv.push(obv[i - 1] + volumes[i]);
    } else if (closes[i] < closes[i - 1]) {
      obv.push(obv[i - 1] - volumes[i]);
    } else {
      obv.push(obv[i - 1]);
    }
  }

  return obv;
}

/**
 * Calculate OBV Trend
 * Returns trend direction based on OBV EMA
 */
export function calculateOBVTrend(
  obv: number[],
  period: number = 10
): "rising" | "falling" | "neutral" {
  if (obv.length < period + 1) return "neutral";

  const obvEMA = calculateEMA(obv, period);
  if (obvEMA.length < 2) return "neutral";

  const current = obvEMA[obvEMA.length - 1];
  const previous = obvEMA[obvEMA.length - 2];
  const change = (current - previous) / Math.abs(previous || 1);

  if (change > 0.01) return "rising";
  if (change < -0.01) return "falling";
  return "neutral";
}

/**
 * Calculate Momentum Acceleration
 * Rate of change of RSI - detects accelerating/decelerating momentum
 */
export function calculateMomentumAcceleration(
  rsi: number[],
  period: number = 5
): number[] {
  if (rsi.length < period + 1) return [];

  const acceleration: number[] = [];

  for (let i = period; i < rsi.length; i++) {
    const currentChange = rsi[i] - rsi[i - 1];
    const previousChange = rsi[i - 1] - rsi[i - period];
    acceleration.push(currentChange - previousChange / (period - 1));
  }

  return acceleration;
}

/**
 * Detect Bollinger Band Squeeze
 * Low volatility period often precedes breakout
 */
export function detectBBSqueeze(
  bb: BollingerBandsResult[],
  lookback: number = 20
): { isSqueeze: boolean; percentile: number } {
  if (bb.length < lookback) {
    return { isSqueeze: false, percentile: 50 };
  }

  const recentBandwidths = bb.slice(-lookback).map((b) => b.bandwidth);
  const currentBandwidth = recentBandwidths[recentBandwidths.length - 1];
  const avgBandwidth =
    recentBandwidths.reduce((a, b) => a + b, 0) / recentBandwidths.length;

  // Sort to find percentile
  const sorted = [...recentBandwidths].sort((a, b) => a - b);
  const percentileIndex = sorted.findIndex((b) => b >= currentBandwidth);
  const percentile = (percentileIndex / sorted.length) * 100;

  // Squeeze if bandwidth is below 25th percentile
  const isSqueeze = currentBandwidth < avgBandwidth * 0.7;

  return { isSqueeze, percentile };
}

/**
 * Calculate Volatility Regime
 * Categorizes market volatility for position sizing
 */
export function calculateVolatilityRegime(
  atr: number[],
  prices: number[],
  lookback: number = 14
): "low" | "normal" | "high" | "extreme" {
  if (atr.length < lookback || prices.length < lookback) {
    return "normal";
  }

  const recentATR = atr.slice(-lookback);
  const recentPrices = prices.slice(-lookback);

  // ATR as percentage of price
  const atrPct = recentATR.map((a, i) => (a / recentPrices[i]) * 100);
  const currentATRPct = atrPct[atrPct.length - 1];
  const avgATRPct = atrPct.reduce((a, b) => a + b, 0) / atrPct.length;

  if (currentATRPct < avgATRPct * 0.5) return "low";
  if (currentATRPct < avgATRPct * 1.2) return "normal";
  if (currentATRPct < avgATRPct * 2) return "high";
  return "extreme";
}

/**
 * Calculate adaptive pivot points adjusted by ATR
 * More dynamic support/resistance levels
 */
export function calculateAdaptivePivots(
  high: number,
  low: number,
  close: number,
  atr: number
): PivotPoints & { atrR1: number; atrR2: number; atrS1: number; atrS2: number } {
  const basePivots = calculatePivotPoints(high, low, close);

  return {
    ...basePivots,
    atrR1: basePivots.pivot + atr * 1,
    atrR2: basePivots.pivot + atr * 2,
    atrS1: basePivots.pivot - atr * 1,
    atrS2: basePivots.pivot - atr * 2,
  };
}
