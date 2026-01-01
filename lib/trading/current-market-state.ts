import { binance } from "./binance";
import {
  calculateADX,
  calculateATR,
  calculateEMA,
  calculateMACD,
  calculateMACDFull,
  calculatePivotPoints,
  calculateRSI,
  calculateBollingerBands,
  calculateStochRSI,
  detectRSIDivergence,
  calculateVWAP,
  calculateOBV,
  calculateOBVTrend,
  calculateVolatilityRegime,
  detectBBSqueeze,
  PivotPoints,
  StochRSIResult,
  Divergence,
} from "./indicators";

// ============================================
// TYPES
// ============================================

export interface ConfluenceScore {
  bullish: number;
  bearish: number;
  factors: string[];
  recommendation: "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";
}

export interface VolatilityMetrics {
  regime: "low" | "normal" | "high" | "extreme";
  bbBandwidth: number;
  bbPercentB: number;
  isSqueeze: boolean;
  squeezePercentile: number;
}

export interface MomentumMetrics {
  stochRSI: StochRSIResult;
  divergence: Divergence;
  macdHistogram: number;
  macdHistogramTrend: "rising" | "falling" | "neutral";
}

export interface VolumeMetrics {
  vwap: number;
  priceVsVwap: "above" | "below" | "at";
  obv: number;
  obvTrend: "rising" | "falling" | "neutral";
  volumeRatio: number;
}

export interface DailyContext {
  trend: "up" | "down" | "sideways";
  ema20: number;
  ema50: number;
  adx: number;
  pivotPoints: PivotPoints;
}

export interface MarketState {
  // Current indicators
  current_price: number;
  current_ema20: number;
  current_macd: number;
  current_rsi: number;
  current_adx: number;

  // Open Interest
  open_interest: {
    latest: number;
    average: number;
  };

  // Funding Rate
  funding_rate: number;

  // Intraday series (by minute)
  intraday: {
    mid_prices: number[];
    ema_20: number[];
    macd: number[];
    rsi_7: number[];
    rsi_14: number[];
  };

  // Longer-term context (4-hour timeframe)
  longer_term: {
    ema_20: number;
    ema_50: number;
    atr_3: number;
    atr_14: number;
    adx_14: number;
    current_volume: number;
    average_volume: number;
    macd: number[];
    rsi_14: number[];
    pivot_points: PivotPoints;
  };

  // NEW: Advanced analytics for profit optimization
  volatility: VolatilityMetrics;
  momentum: MomentumMetrics;
  volume: VolumeMetrics;
  daily: DailyContext;
  confluence: ConfluenceScore;

  // NEW: Pre-calculated risk metrics
  suggestedStopLoss: number;
  suggestedTakeProfit: number;
}

// ============================================
// CONFLUENCE CALCULATION
// ============================================

function calculateConfluenceScore(
  currentPrice: number,
  ema20_4h: number,
  ema50_4h: number,
  adx: number,
  rsi: number,
  volumeRatio: number,
  fundingRate: number,
  divergence: Divergence,
  stochRSI: StochRSIResult,
  dailyTrend: string,
  pivotPoints: PivotPoints,
  bbPercentB: number
): ConfluenceScore {
  let bullish = 0;
  let bearish = 0;
  const factors: string[] = [];

  // 1. Trend Alignment (weight: 2)
  if (ema20_4h > ema50_4h) {
    bullish += 2;
    factors.push("4H Trend: Bullish (EMA20 > EMA50)");
  } else if (ema20_4h < ema50_4h) {
    bearish += 2;
    factors.push("4H Trend: Bearish (EMA20 < EMA50)");
  }

  // 2. Daily Trend Confirmation (weight: 1.5)
  if (dailyTrend === "up") {
    bullish += 1.5;
    factors.push("Daily Trend: Bullish");
  } else if (dailyTrend === "down") {
    bearish += 1.5;
    factors.push("Daily Trend: Bearish");
  }

  // 3. ADX Strength (weight: 1.5)
  if (adx > 25) {
    const trendDirection = ema20_4h > ema50_4h ? "bullish" : "bearish";
    if (trendDirection === "bullish") {
      bullish += 1.5;
    } else {
      bearish += 1.5;
    }
    factors.push(`ADX: ${adx.toFixed(1)} (Strong ${trendDirection} trend)`);
  } else if (adx < 20) {
    factors.push(`ADX: ${adx.toFixed(1)} (Weak/Range-bound)`);
  }

  // 4. RSI Zones (weight: 1)
  if (rsi < 30) {
    bullish += 1;
    factors.push(`RSI: ${rsi.toFixed(1)} (Oversold - Bullish)`);
  } else if (rsi > 70) {
    bearish += 1;
    factors.push(`RSI: ${rsi.toFixed(1)} (Overbought - Bearish)`);
  } else if (rsi >= 40 && rsi <= 60) {
    factors.push(`RSI: ${rsi.toFixed(1)} (Neutral zone)`);
  }

  // 5. StochRSI Signal (weight: 1)
  if (stochRSI.k < 20 && stochRSI.k > stochRSI.d) {
    bullish += 1;
    factors.push("StochRSI: Bullish crossover from oversold");
  } else if (stochRSI.k > 80 && stochRSI.k < stochRSI.d) {
    bearish += 1;
    factors.push("StochRSI: Bearish crossover from overbought");
  }

  // 6. Volume Confirmation (weight: 0.5)
  if (volumeRatio > 1.2) {
    factors.push(`Volume: ${(volumeRatio * 100).toFixed(0)}% of average (Surge)`);
    // Add to existing trend direction
    if (ema20_4h > ema50_4h) bullish += 0.5;
    else bearish += 0.5;
  }

  // 7. Funding Rate (weight: 0.5)
  if (fundingRate > 0.0005) {
    bearish += 0.5;
    factors.push(`Funding: ${(fundingRate * 100).toFixed(3)}% (Crowded longs)`);
  } else if (fundingRate < -0.0001) {
    bullish += 0.5;
    factors.push(`Funding: ${(fundingRate * 100).toFixed(3)}% (Shorts paying)`);
  }

  // 8. Divergence (weight: 1.5)
  if (divergence.type === "bullish") {
    bullish += 1.5 * divergence.strength;
    factors.push(`Divergence: Bullish (strength: ${(divergence.strength * 100).toFixed(0)}%)`);
  } else if (divergence.type === "bearish") {
    bearish += 1.5 * divergence.strength;
    factors.push(`Divergence: Bearish (strength: ${(divergence.strength * 100).toFixed(0)}%)`);
  }

  // 9. Price vs Support/Resistance (weight: 1)
  const distToS1 = (currentPrice - pivotPoints.s1) / currentPrice;
  const distToR1 = (pivotPoints.r1 - currentPrice) / currentPrice;

  if (distToS1 < 0.01 && distToS1 > -0.005) {
    bullish += 1;
    factors.push(`Price at Support S1: $${pivotPoints.s1.toFixed(2)}`);
  } else if (distToR1 < 0.01 && distToR1 > -0.005) {
    bearish += 1;
    factors.push(`Price at Resistance R1: $${pivotPoints.r1.toFixed(2)}`);
  }

  // 10. Bollinger %B (weight: 0.5)
  if (bbPercentB < 0.2) {
    bullish += 0.5;
    factors.push("Price near lower Bollinger Band (Oversold)");
  } else if (bbPercentB > 0.8) {
    bearish += 0.5;
    factors.push("Price near upper Bollinger Band (Overbought)");
  }

  // Determine recommendation
  const netScore = bullish - bearish;
  let recommendation: ConfluenceScore["recommendation"];

  if (netScore >= 5) recommendation = "STRONG_BUY";
  else if (netScore >= 2) recommendation = "BUY";
  else if (netScore <= -5) recommendation = "STRONG_SELL";
  else if (netScore <= -2) recommendation = "SELL";
  else recommendation = "NEUTRAL";

  return { bullish, bearish, factors, recommendation };
}

// ============================================
// MAIN FUNCTION
// ============================================

export async function getCurrentMarketState(
  symbol: string
): Promise<MarketState> {
  try {
    // Normalize symbol format for Binance
    const normalizedSymbol = symbol.includes("/") ? symbol : `${symbol}/USDT`;

    // Fetch OHLCV data for multiple timeframes
    const [ohlcv1m, ohlcv4h, ohlcv1d] = await Promise.all([
      binance.fetchOHLCV(normalizedSymbol, "1m", undefined, 100),
      binance.fetchOHLCV(normalizedSymbol, "4h", undefined, 100),
      binance.fetchOHLCV(normalizedSymbol, "1d", undefined, 50),
    ]);

    // Extract data from 1-minute candles
    const closes1m = ohlcv1m.map((c) => Number(c[4]));

    // Extract data from 4-hour candles
    const closes4h = ohlcv4h.map((c) => Number(c[4]));
    const highs4h = ohlcv4h.map((c) => Number(c[2]));
    const lows4h = ohlcv4h.map((c) => Number(c[3]));
    const volumes4h = ohlcv4h.map((c) => Number(c[5]));

    // Extract data from daily candles
    const closes1d = ohlcv1d.map((c) => Number(c[4]));
    const highs1d = ohlcv1d.map((c) => Number(c[2]));
    const lows1d = ohlcv1d.map((c) => Number(c[3]));

    // ============================================
    // CALCULATE BASIC INDICATORS
    // ============================================

    // 1-minute indicators
    const ema20_1m = calculateEMA(closes1m, 20);
    const macd_1m = calculateMACD(closes1m);
    const rsi7_1m = calculateRSI(closes1m, 7);
    const rsi14_1m = calculateRSI(closes1m, 14);

    // 4-hour indicators
    const ema20_4h = calculateEMA(closes4h, 20);
    const ema50_4h = calculateEMA(closes4h, 50);
    const atr3_4h = calculateATR(highs4h, lows4h, closes4h, 3);
    const atr14_4h = calculateATR(highs4h, lows4h, closes4h, 14);
    const macd_4h = calculateMACD(closes4h);
    const macdFull_4h = calculateMACDFull(closes4h);
    const rsi14_4h = calculateRSI(closes4h, 14);
    const adx14_4h = calculateADX(highs4h, lows4h, closes4h, 14);

    // Daily indicators
    const ema20_1d = calculateEMA(closes1d, 20);
    const ema50_1d = calculateEMA(closes1d, 50);
    const adx14_1d = calculateADX(highs1d, lows1d, closes1d, 14);

    // Pivot points from previous 4H candle
    const prev4h = {
      high: highs4h[highs4h.length - 2],
      low: lows4h[lows4h.length - 2],
      close: closes4h[closes4h.length - 2],
    };
    const pivotPoints = calculatePivotPoints(prev4h.high, prev4h.low, prev4h.close);

    // Daily pivot points
    const prev1d = {
      high: highs1d[highs1d.length - 2],
      low: lows1d[lows1d.length - 2],
      close: closes1d[closes1d.length - 2],
    };
    const dailyPivots = calculatePivotPoints(prev1d.high, prev1d.low, prev1d.close);

    // ============================================
    // CALCULATE NEW INDICATORS
    // ============================================

    // Bollinger Bands (4h)
    const bb4h = calculateBollingerBands(closes4h, 20, 2);
    const currentBB = bb4h[bb4h.length - 1] || { upper: 0, middle: 0, lower: 0, bandwidth: 0, percentB: 0.5 };
    const bbSqueeze = detectBBSqueeze(bb4h);

    // Stochastic RSI (4h)
    const stochRSI4h = calculateStochRSI(closes4h);
    const currentStochRSI = stochRSI4h[stochRSI4h.length - 1] || { stochRSI: 50, k: 50, d: 50 };

    // RSI Divergence (4h)
    const divergence = detectRSIDivergence(closes4h, rsi14_4h, 14);

    // VWAP (4h session)
    const vwap4h = calculateVWAP(highs4h, lows4h, closes4h, volumes4h);
    const currentVWAP = vwap4h[vwap4h.length - 1] || closes4h[closes4h.length - 1];

    // OBV (4h)
    const obv4h = calculateOBV(closes4h, volumes4h);
    const currentOBV = obv4h[obv4h.length - 1] || 0;
    const obvTrend = calculateOBVTrend(obv4h);

    // Volatility regime
    const volatilityRegime = calculateVolatilityRegime(atr14_4h, closes4h);

    // ============================================
    // EXTRACT CURRENT VALUES
    // ============================================

    const current_price = closes1m[closes1m.length - 1];
    const current_ema20 = ema20_1m[ema20_1m.length - 1] || 0;
    const current_macd = macd_1m[macd_1m.length - 1] || 0;
    const current_rsi = rsi7_1m[rsi7_1m.length - 1] || 50;
    const current_adx = adx14_4h[adx14_4h.length - 1] || 0;

    const ema20_4h_current = ema20_4h[ema20_4h.length - 1] || 0;
    const ema50_4h_current = ema50_4h[ema50_4h.length - 1] || 0;
    const atr14_current = atr14_4h[atr14_4h.length - 1] || 0;

    // Volume metrics
    const avgVolume4h = volumes4h.reduce((a, b) => a + b, 0) / volumes4h.length;
    const currentVolume4h = volumes4h[volumes4h.length - 1];
    const volumeRatio = avgVolume4h > 0 ? currentVolume4h / avgVolume4h : 1;

    // MACD histogram
    const currentMACDFull = macdFull_4h[macdFull_4h.length - 1] || { macd: 0, signal: 0, histogram: 0 };
    const prevMACDFull = macdFull_4h[macdFull_4h.length - 2] || { macd: 0, signal: 0, histogram: 0 };
    const macdHistogramTrend: "rising" | "falling" | "neutral" =
      currentMACDFull.histogram > prevMACDFull.histogram ? "rising" :
      currentMACDFull.histogram < prevMACDFull.histogram ? "falling" : "neutral";

    // Daily trend
    const ema20_1d_current = ema20_1d[ema20_1d.length - 1] || 0;
    const ema50_1d_current = ema50_1d[ema50_1d.length - 1] || 0;
    const adx14_1d_current = adx14_1d[adx14_1d.length - 1] || 0;
    const dailyTrend: "up" | "down" | "sideways" =
      ema20_1d_current > ema50_1d_current * 1.002 ? "up" :
      ema20_1d_current < ema50_1d_current * 0.998 ? "down" : "sideways";

    // Price vs VWAP
    const priceVsVwap: "above" | "below" | "at" =
      current_price > currentVWAP * 1.001 ? "above" :
      current_price < currentVWAP * 0.999 ? "below" : "at";

    // ============================================
    // FETCH OPEN INTEREST & FUNDING RATE
    // ============================================

    const openInterestData = { latest: 0, average: 0 };
    let fundingRate = 0;

    try {
      const perpSymbol = normalizedSymbol.replace("/", "");
      const openInterest = await binance.fetchOpenInterest(perpSymbol);
      if (openInterest?.openInterestAmount) {
        openInterestData.latest = openInterest.openInterestAmount;
        openInterestData.average = openInterest.openInterestAmount;
      }

      const fundingRates = await binance.fetchFundingRate(normalizedSymbol);
      if (fundingRates?.fundingRate) {
        fundingRate = fundingRates.fundingRate;
      }
    } catch {
      console.warn("Could not fetch open interest or funding rate");
    }

    // ============================================
    // CALCULATE CONFLUENCE SCORE
    // ============================================

    const confluence = calculateConfluenceScore(
      current_price,
      ema20_4h_current,
      ema50_4h_current,
      current_adx,
      rsi14_4h[rsi14_4h.length - 1] || 50,
      volumeRatio,
      fundingRate,
      divergence,
      currentStochRSI,
      dailyTrend,
      pivotPoints,
      currentBB.percentB
    );

    // ============================================
    // CALCULATE SUGGESTED SL/TP
    // ============================================

    // SL: Below S1 or 1.5x ATR, whichever is closer
    const slFromPivot = pivotPoints.s1;
    const slFromATR = current_price - atr14_current * 1.5;
    const suggestedStopLoss = Math.max(slFromPivot, slFromATR);

    // TP: At R1 or 2x ATR, whichever is closer (minimum 1.5:1 R:R)
    const riskAmount = current_price - suggestedStopLoss;
    const minTP = current_price + riskAmount * 1.5;
    const tpFromPivot = pivotPoints.r1;
    const tpFromATR = current_price + atr14_current * 2;
    const suggestedTakeProfit = Math.max(minTP, Math.min(tpFromPivot, tpFromATR));

    // ============================================
    // BUILD RESPONSE
    // ============================================

    return {
      current_price,
      current_ema20,
      current_macd,
      current_rsi,
      current_adx,
      open_interest: openInterestData,
      funding_rate: fundingRate,

      intraday: {
        mid_prices: closes1m.slice(-10),
        ema_20: ema20_1m.slice(-10).map((v) => v || 0),
        macd: macd_1m.slice(-10).map((v) => v || 0),
        rsi_7: rsi7_1m.slice(-10).map((v) => v || 0),
        rsi_14: rsi14_1m.slice(-10).map((v) => v || 0),
      },

      longer_term: {
        ema_20: ema20_4h_current,
        ema_50: ema50_4h_current,
        atr_3: atr3_4h[atr3_4h.length - 1] || 0,
        atr_14: atr14_current,
        adx_14: current_adx,
        current_volume: currentVolume4h,
        average_volume: avgVolume4h,
        macd: macd_4h.slice(-10).map((v) => v || 0),
        rsi_14: rsi14_4h.slice(-10).map((v) => v || 0),
        pivot_points: pivotPoints,
      },

      volatility: {
        regime: volatilityRegime,
        bbBandwidth: currentBB.bandwidth,
        bbPercentB: currentBB.percentB,
        isSqueeze: bbSqueeze.isSqueeze,
        squeezePercentile: bbSqueeze.percentile,
      },

      momentum: {
        stochRSI: currentStochRSI,
        divergence,
        macdHistogram: currentMACDFull.histogram,
        macdHistogramTrend,
      },

      volume: {
        vwap: currentVWAP,
        priceVsVwap,
        obv: currentOBV,
        obvTrend,
        volumeRatio,
      },

      daily: {
        trend: dailyTrend,
        ema20: ema20_1d_current,
        ema50: ema50_1d_current,
        adx: adx14_1d_current,
        pivotPoints: dailyPivots,
      },

      confluence,
      suggestedStopLoss,
      suggestedTakeProfit,
    };
  } catch (error) {
    console.error("Error fetching market state:", error);
    throw error;
  }
}

// ============================================
// FORMAT FOR AI PROMPT
// ============================================

export function formatMarketState(state: MarketState): string {
  return `
## Current Market State
- Price: $${state.current_price.toFixed(2)}
- EMA20 (1m): $${state.current_ema20.toFixed(2)}
- RSI (7): ${state.current_rsi.toFixed(1)}
- ADX (4h): ${state.current_adx.toFixed(1)} (${state.current_adx > 25 ? "Strong Trend" : "Weak/Range"})

## Market Microstructure
- Open Interest: ${state.open_interest.latest.toFixed(0)}
- Funding Rate: ${(state.funding_rate * 100).toFixed(4)}%

## Volatility Analysis
- Regime: ${state.volatility.regime.toUpperCase()}
- Bollinger Bandwidth: ${(state.volatility.bbBandwidth * 100).toFixed(2)}%
- Bollinger %B: ${(state.volatility.bbPercentB * 100).toFixed(1)}%
- Squeeze: ${state.volatility.isSqueeze ? "YES (Breakout imminent)" : "No"}

## Momentum Analysis
- StochRSI K: ${state.momentum.stochRSI.k.toFixed(1)}, D: ${state.momentum.stochRSI.d.toFixed(1)}
- MACD Histogram: ${state.momentum.macdHistogram.toFixed(2)} (${state.momentum.macdHistogramTrend})
- Divergence: ${state.momentum.divergence.type || "None"} ${state.momentum.divergence.strength > 0 ? `(${(state.momentum.divergence.strength * 100).toFixed(0)}%)` : ""}

## Volume Analysis
- VWAP: $${state.volume.vwap.toFixed(2)} (Price ${state.volume.priceVsVwap} VWAP)
- OBV Trend: ${state.volume.obvTrend}
- Volume Ratio: ${(state.volume.volumeRatio * 100).toFixed(0)}% of average

## 4-Hour Context
- EMA20: $${state.longer_term.ema_20.toFixed(2)} vs EMA50: $${state.longer_term.ema_50.toFixed(2)}
- Trend: ${state.longer_term.ema_20 > state.longer_term.ema_50 ? "BULLISH" : "BEARISH"}
- ATR (14): ${state.longer_term.atr_14.toFixed(2)}
- Pivot Points: P=$${state.longer_term.pivot_points.pivot.toFixed(2)}, S1=$${state.longer_term.pivot_points.s1.toFixed(2)}, R1=$${state.longer_term.pivot_points.r1.toFixed(2)}

## Daily Context
- Trend: ${state.daily.trend.toUpperCase()}
- EMA20: $${state.daily.ema20.toFixed(2)} vs EMA50: $${state.daily.ema50.toFixed(2)}
- ADX: ${state.daily.adx.toFixed(1)}

## Confluence Analysis
- Bullish Score: ${state.confluence.bullish.toFixed(1)}/10
- Bearish Score: ${state.confluence.bearish.toFixed(1)}/10
- Recommendation: ${state.confluence.recommendation}
- Factors:
${state.confluence.factors.map((f) => `  - ${f}`).join("\n")}

## Suggested Levels
- Stop Loss: $${state.suggestedStopLoss.toFixed(2)}
- Take Profit: $${state.suggestedTakeProfit.toFixed(2)}

## Intraday Data (1m, last 10)
- Prices: [${state.intraday.mid_prices.map((v) => v.toFixed(1)).join(", ")}]
- RSI(7): [${state.intraday.rsi_7.map((v) => v.toFixed(1)).join(", ")}]
`.trim();
}
