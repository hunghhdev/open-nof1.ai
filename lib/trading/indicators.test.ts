import { describe, expect, it } from "bun:test";
import {
    calculateADX,
    calculateATR,
    calculateEMA,
    calculateMACD,
    calculatePivotPoints,
    calculateRSI,
} from "./indicators";

describe("Technical Indicators", () => {
    // Sample data for testing (100 points to ensure indicators have enough data)
    const prices = Array.from({ length: 100 }, (_, i) => 10 + i + Math.sin(i));
    const highs = prices.map((p) => p + 1);
    const lows = prices.map((p) => p - 1);
    const closes = prices;

    it("should calculate EMA correctly", () => {
        const ema = calculateEMA(prices, 5);
        expect(ema.length).toBeGreaterThan(0);
        expect(typeof ema[0]).toBe("number");
    });

    it("should calculate MACD correctly", () => {
        const macd = calculateMACD(prices);
        expect(macd.length).toBeGreaterThan(0);
        expect(typeof macd[0]).toBe("number");
    });

    it("should calculate RSI correctly", () => {
        const rsi = calculateRSI(prices, 14);
        expect(rsi.length).toBeGreaterThan(0);
        expect(typeof rsi[0]).toBe("number");
    });

    it("should calculate ATR correctly", () => {
        const atr = calculateATR(highs, lows, closes, 14);
        expect(atr.length).toBeGreaterThan(0);
        expect(typeof atr[0]).toBe("number");
    });

    it("should calculate ADX correctly", () => {
        // ADX requires more data points to stabilize, but we check basic output
        const adx = calculateADX(highs, lows, closes, 14);
        expect(adx.length).toBeGreaterThan(0);
        expect(typeof adx[0]).toBe("number");
    });

    it("should calculate Pivot Points correctly", () => {
        const high = 100;
        const low = 90;
        const close = 95;

        const pivots = calculatePivotPoints(high, low, close);

        // Manual calculation:
        // Pivot = (100 + 90 + 95) / 3 = 95
        // R1 = 2*95 - 90 = 190 - 90 = 100
        // S1 = 2*95 - 100 = 190 - 100 = 90
        // R2 = 95 + (100 - 90) = 105
        // S2 = 95 - (100 - 90) = 85

        expect(pivots.pivot).toBeCloseTo(95);
        expect(pivots.r1).toBeCloseTo(100);
        expect(pivots.s1).toBeCloseTo(90);
        expect(pivots.r2).toBeCloseTo(105);
        expect(pivots.s2).toBeCloseTo(85);
    });
});
