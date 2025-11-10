import { generateObject } from "ai";
import { generateUserPrompt, tradingPrompt } from "./prompt";
import { getCurrentMarketState } from "../trading/current-market-state";
import { z } from "zod";
import { deepseekR1, deepseekThinking } from "./model";
import { getAccountInformationAndPerformance } from "../trading/account-information-and-performance";
import { prisma } from "../prisma";
import { Opeartion, Symbol } from "@prisma/client";

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
 * you can interval trading using cron job
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

    const { object, reasoning } = await generateObject({
      model,
      system: tradingPrompt,
      prompt: userPrompt,
      schema: z.object({
        opeartion: z.nativeEnum(Opeartion),
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

    if (object.opeartion === Opeartion.Buy) {
      // Validation: Buy operation must have buy object
      if (!object.buy) {
        console.error(`[${tradingPair}] Buy operation missing buy object`);
        continue;
      }

      await prisma.chat.create({
        data: {
          reasoning: reasoning || "<no reasoning>",
          chat: object.chat || "<no chat>",
          userPrompt,
          tradings: {
            createMany: {
              data: {
                symbol: symbolEnum,
                opeartion: object.opeartion,
                pricing: object.buy.pricing,
                amount: object.buy.amount,
                leverage: object.buy.leverage,
              },
            },
          },
        },
      });
    }

    if (object.opeartion === Opeartion.Sell) {
      // Validation: Sell operation must have sell object
      if (!object.sell) {
        console.error(`[${tradingPair}] Sell operation missing sell object`);
        continue;
      }

      await prisma.chat.create({
        data: {
          reasoning: reasoning || "<no reasoning>",
          chat: object.chat || "<no chat>",
          userPrompt,
          tradings: {
            createMany: {
              data: {
                symbol: symbolEnum,
                opeartion: object.opeartion,
                percentage: object.sell.percentage,
              },
            },
          },
        },
      });
    }

    if (object.opeartion === Opeartion.Hold) {
      // Allow individual adjustment of stopLoss or takeProfit (capital preservation priority)
      await prisma.chat.create({
        data: {
          reasoning: reasoning || "<no reasoning>",
          chat: object.chat || "<no chat>",
          userPrompt,
          tradings: {
            createMany: {
              data: {
                symbol: symbolEnum,
                opeartion: object.opeartion,
                stopLoss: object.adjustProfit?.stopLoss,
                takeProfit: object.adjustProfit?.takeProfit,
              },
            },
          },
        },
      });
    }
  }
}
