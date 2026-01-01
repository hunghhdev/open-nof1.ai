import { generateText } from "ai";
import { generateUserPrompt, tradingPrompt } from "./prompt";
import { getCurrentMarketState } from "../trading/current-market-state";
import { z } from "zod";
import { deepseekR1, deepseekThinking } from "./model";
import { getAccountInformationAndPerformance } from "../trading/account-information-and-performance";
import { prisma } from "../prisma";
import { Operation, Symbol, ExecutionStatus } from "@prisma/client";
import { executeBuy, executeSell, updateStopLossTakeProfit } from "../trading/executor";

// Schema for AI response validation
const tradingResponseSchema = z.object({
  operation: z.enum(["Buy", "Sell", "Hold"]),
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
});

type TradingResponse = z.infer<typeof tradingResponseSchema>;

/**
 * Extract JSON from AI response text
 * Handles cases where JSON is wrapped in markdown code blocks
 */
function extractJSON(text: string): string {
  // Try to find JSON in code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }

  return text;
}

/**
 * Parse and validate AI response
 */
function parseAIResponse(text: string): TradingResponse | null {
  try {
    const jsonStr = extractJSON(text);
    const parsed = JSON.parse(jsonStr);

    // Clean up null values that should be undefined
    if (parsed.buy === null) delete parsed.buy;
    if (parsed.sell === null) delete parsed.sell;
    if (parsed.adjustProfit === null) delete parsed.adjustProfit;

    return tradingResponseSchema.parse(parsed);
  } catch {
    return null;
  }
}

// Suppress AI SDK warnings - models work fine via tool calling despite warning
if (typeof globalThis !== "undefined") {
  (globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;
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

      let object: TradingResponse | null = null;
      let reasoning = "";

      try {
        const result = await generateText({
          model,
          system: tradingPrompt,
          prompt: userPrompt,
        });

        // Handle reasoning - can be string, array, or object
        if (typeof result.reasoning === "string") {
          reasoning = result.reasoning;
        } else if (Array.isArray(result.reasoning)) {
          reasoning = result.reasoning
            .map((r: unknown) => {
              if (typeof r === "string") return r;
              if (r && typeof r === "object" && "text" in r) return (r as { text: string }).text;
              return JSON.stringify(r);
            })
            .join("\n");
        } else if (result.reasoning) {
          reasoning = JSON.stringify(result.reasoning);
        }

        // Parse JSON from the response text
        object = parseAIResponse(result.text);

        if (!object) {
          throw new Error(`Failed to parse AI response: ${result.text.substring(0, 500)}`);
        }
      } catch (aiError: unknown) {
        const errorMessage = aiError instanceof Error ? aiError.message : String(aiError);
        // Detailed error logging for AI failures
        console.error(`\n${"=".repeat(80)}`);
        console.error(`[AI ERROR] ❌ Failed for ${tradingPair}`);
        console.error(`${"=".repeat(80)}`);
        console.error(`Error: ${errorMessage}`);
        console.error(`${"=".repeat(80)}\n`);

        // Save error to database for analysis
        await prisma.chat.create({
          data: {
            reasoning: `AI_ERROR: ${errorMessage}`,
            chat: `AI failed for ${tradingPair}. Error: ${errorMessage}`,
            userPrompt,
            trades: {
              create: {
                symbol: symbolEnum,
                operation: Operation.Hold,
                status: "FAILED",
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
                status: ExecutionStatus.FILLED,
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
            data: { status: ExecutionStatus.FILLED },
          });
        }
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ERROR] Failed to process ${tradingPair}:`, errMsg);
      // Continue with next symbol
      continue;
    }
  }
}
