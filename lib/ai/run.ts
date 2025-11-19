import { generateObject } from "ai";
import { generateUserPrompt, tradingPrompt } from "./prompt";
import { getCurrentMarketState } from "../trading/current-market-state";
import { z } from "zod";
import { deepseekR1, deepseekThinking } from "./model";
import { getAccountInformationAndPerformance } from "../trading/account-information-and-performance";
import { prisma } from "../prisma";
import { Operation, Symbol } from "@prisma/client";
import { executeBuy, executeSell, updateStopLossTakeProfit } from "../trading/executor";

const operationValues = Object.values(Operation) as [string, ...string[]];

// Suppress AI SDK warnings - models work fine via tool calling despite warning
if (typeof globalThis !== "undefined") {
  (globalThis as any).AI_SDK_LOG_WARNINGS = false;
}

/**
 * Maps trading pair strings to Symbol enum
 */
function mapSymbol(tradingPair: string): Symbol {
  const symbol = tradingPair.split("/")[0].toUpperCase();
  if (symbol in Symbol) {
    return Symbol[symbol as keyof typeof Symbol];
  }
  throw new Error(`Unsupported symbol: ${symbol}`);
}

/**
 * Main trading loop - called by cron job
 */
export async function run(initialCapital: number) {
  // Read trading symbols from environment variable, default to BTC/USDT
  const tradingSymbolsEnv = process.env.TRADING_SYMBOLS || "BTC/USDT";
  const tradingSymbols = tradingSymbolsEnv.split(",").map((s) => s.trim());

  const accountInformationAndPerformance =
    await getAccountInformationAndPerformance(initialCapital);
  // Count previous Chat entries to provide an invocation counter in the prompt
  const invocationCount = await prisma.chat.count();

  // Process each trading symbol
  for (const tradingPair of tradingSymbols) {
    try {
      const currentMarketState = await getCurrentMarketState(tradingPair);
      const symbolEnum = mapSymbol(tradingPair);

      const userPrompt = generateUserPrompt({
        currentMarketState,
        accountInformationAndPerformance,
        startTime: new Date(),
        invocationCount,
        symbol: tradingPair,
      });

      const model = process.env.OPENROUTER_API_KEY
        ? deepseekR1
        : deepseekThinking;

      let object, reasoning;

      try {
        const result = await generateObject({
          model,
          system: tradingPrompt,
          prompt: userPrompt,
          schema: z.object({
            operation: z.enum(operationValues),
            buy: z
              .object({
                pricing: z.number(),
                amount: z.number(),
                leverage: z.number().min(1).max(20),
              })
              .optional(),
            sell: z
              .object({
                percentage: z.number().min(0).max(100),
              })
              .optional(),
            adjustProfit: z
              .object({
                stopLoss: z.number().optional(),
                takeProfit: z.number().optional(),
              })
              .optional(),
            chat: z.string(),
          }),
        });

        object = result.object;
        reasoning = result.reasoning;
      } catch (aiError: any) {
        // Detailed error logging for AI schema validation failures
        console.error(`\n${"=".repeat(80)}`);
        console.error(`[AI ERROR] ❌ Schema validation failed for ${tradingPair}`);
        console.error(`${"=".repeat(80)}`);
        console.error(`Error Type: ${aiError.constructor.name}`);
        console.error(`Error Message: ${aiError.message}`);

        // Log the raw error object
        if (aiError.cause) {
          console.error(`\n[AI ERROR] Error Cause:`, JSON.stringify(aiError.cause, null, 2));
        }

        // Log validation errors if available (Zod errors)
        if (aiError.errors) {
          console.error(`\n[AI ERROR] Validation Errors:`, JSON.stringify(aiError.errors, null, 2));
        }

        // Try to extract and log raw response if available
        if (aiError.response) {
          console.error(`\n[AI ERROR] Raw AI Response:`, JSON.stringify(aiError.response, null, 2));
        }

        if (aiError.data) {
          console.error(`\n[AI ERROR] Response Data:`, JSON.stringify(aiError.data, null, 2));
        }

        // Log the expected schema structure
        console.error(`\n[AI ERROR] Expected Schema Structure:`);
        console.error(`{
  operation: "Buy" | "Sell" | "Hold",
  buy?: { pricing: number, amount: number, leverage: number (1-20) },
  sell?: { percentage: number (0-100) },
  adjustProfit?: { stopLoss?: number, takeProfit?: number },
  chat: string
}`);

        console.error(`\n[AI ERROR] 📋 Action Items:`);
        console.error(`  1. Check if AI model returned a valid response`);
        console.error(`  2. Verify prompt is clear and not causing confusion`);
        console.error(`  3. Check if model has rate limits or API issues`);
        console.error(`  4. Consider adjusting prompt or schema if pattern repeats`);
        console.error(`${"=".repeat(80)}\n`);

        // Save error to database for analysis
        await prisma.chat.create({
          data: {
            reasoning: `AI_ERROR: ${aiError.message}`,
            chat: `Schema validation failed for ${tradingPair}. Error: ${aiError.message}`,
            userPrompt,
            trades: {
              create: {
                symbol: symbolEnum,
                operation: Operation.Hold,
                status: "FAILED" as any,
              },
            },
          },
          include: { trades: true },
        });

        // Skip this symbol and continue
        continue;
      }

      console.log(`[AI] Decision for ${tradingPair}:`, {
        operation: object.operation,
        reasoning: object.chat,
      });

      // ============================================
      // BUY OPERATION
      // ============================================
      if (object.operation === Operation.Buy) {
        // Validation: Buy operation must have buy object
        if (!object.buy) {
          console.error(`[${tradingPair}] Buy operation missing buy object`);
          continue;
        }

        // Create trade record first (status: PENDING)
        const trade = await prisma.chat.create({
          data: {
            reasoning: reasoning || "<no reasoning>",
            chat: object.chat || "<no chat>",
            userPrompt,
            trades: {
              create: {
                symbol: symbolEnum,
                operation: object.operation as Operation,
                pricing: object.buy.pricing,
                amount: object.buy.amount,
                leverage: object.buy.leverage,
                stopLoss: object.adjustProfit?.stopLoss,
                takeProfit: object.adjustProfit?.takeProfit,
                // status: PENDING by default
              },
            },
          },
          include: { trades: true },
        });

        const tradeRecord = trade.trades[0];

        // Execute on Binance
        const result = await executeBuy({
          symbol: symbolEnum,
          amount: object.buy.amount,
          leverage: object.buy.leverage,
          stopLoss: object.adjustProfit?.stopLoss,
          takeProfit: object.adjustProfit?.takeProfit,
          tradeId: tradeRecord.id,
        });

        if (result.success) {
          console.log(`[SUCCESS] Buy executed for ${tradingPair}:`, {
            orderId: result.orderId,
            price: result.executedPrice,
            amount: result.executedAmount,
          });
        } else {
          console.error(`[FAILED] Buy failed for ${tradingPair}:`, result.error);
        }
      }

      // ============================================
      // SELL OPERATION
      // ============================================
      if (object.operation === Operation.Sell) {
        // Validation: Sell operation must have sell object
        if (!object.sell) {
          console.error(`[${tradingPair}] Sell operation missing sell object`);
          continue;
        }

        // Create trade record
        const trade = await prisma.chat.create({
          data: {
            reasoning: reasoning || "<no reasoning>",
            chat: object.chat || "<no chat>",
            userPrompt,
            trades: {
              create: {
                symbol: symbolEnum,
                operation: object.operation as Operation,
                percentage: object.sell.percentage,
                stopLoss: object.adjustProfit?.stopLoss,
                takeProfit: object.adjustProfit?.takeProfit,
              },
            },
          },
          include: { trades: true },
        });

        const tradeRecord = trade.trades[0];

        // Execute on Binance
        const result = await executeSell({
          symbol: symbolEnum,
          percentage: object.sell.percentage,
          tradeId: tradeRecord.id,
        });

        if (result.success) {
          console.log(`[SUCCESS] Sell executed for ${tradingPair}:`, {
            orderId: result.orderId,
            price: result.executedPrice,
            amount: result.executedAmount,
          });
        } else {
          console.error(`[FAILED] Sell failed for ${tradingPair}:`, result.error);
        }
      }

      // ============================================
      // HOLD OPERATION
      // ============================================
      if (object.operation === Operation.Hold) {
        // Create trade record
        const trade = await prisma.chat.create({
          data: {
            reasoning: reasoning || "<no reasoning>",
            chat: object.chat || "<no chat>",
            userPrompt,
            trades: {
              create: {
                symbol: symbolEnum,
                operation: object.operation as Operation,
                stopLoss: object.adjustProfit?.stopLoss,
                takeProfit: object.adjustProfit?.takeProfit,
              },
            },
          },
          include: { trades: true },
        });

        const tradeRecord = trade.trades[0];

        // Update SL/TP if provided
        if (object.adjustProfit?.stopLoss || object.adjustProfit?.takeProfit) {
          // Check if we actually have an open position to update
          const existingPosition = await prisma.position.findFirst({
            where: {
              symbol: symbolEnum,
              status: "OPEN",
            },
          });

          if (!existingPosition) {
            console.log(`[HOLD] No open position for ${tradingPair}, skipping SL/TP update (treated as Wait).`);
            await prisma.trade.update({
              where: { id: tradeRecord.id },
              data: {
                status: "FILLED" as any,
                error: "No open position to update. Treated as Wait."
              },
            });
            continue;
          }

          const result = await updateStopLossTakeProfit({
            symbol: symbolEnum,
            stopLoss: object.adjustProfit.stopLoss,
            takeProfit: object.adjustProfit.takeProfit,
            tradeId: tradeRecord.id,
          });

          if (result.success) {
            console.log(`[SUCCESS] Updated SL/TP for ${tradingPair}`);
          } else {
            console.error(`[FAILED] Update SL/TP failed for ${tradingPair}:`, result.error);
          }
        } else {
          // Hold without changes - just log
          console.log(`[HOLD] No action needed for ${tradingPair}`);
          await prisma.trade.update({
            where: { id: tradeRecord.id },
            data: { status: "FILLED" as any }, // Mark as processed
          });
        }
      }
    } catch (error: any) {
      console.error(`[ERROR] Failed to process ${tradingPair}:`, error.message);
      // Continue with next symbol
      continue;
    }
  }
}
