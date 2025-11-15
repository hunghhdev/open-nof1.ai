-- CreateEnum
CREATE TYPE "Symbol" AS ENUM ('BTC', 'ETH', 'BNB', 'SOL', 'DOGE');

-- CreateEnum
CREATE TYPE "Operation" AS ENUM ('Buy', 'Sell', 'Hold');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'EXECUTING', 'FILLED', 'PARTIAL', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED', 'LIQUIDATED');

-- CreateEnum
CREATE TYPE "ModelType" AS ENUM ('Deepseek', 'DeepseekThinking', 'Qwen', 'Doubao');

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "model" "ModelType" NOT NULL DEFAULT 'Deepseek',
    "chat" TEXT NOT NULL DEFAULT '<no chat>',
    "reasoning" TEXT NOT NULL,
    "userPrompt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "symbol" "Symbol" NOT NULL,
    "operation" "Operation" NOT NULL,
    "pricing" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION,
    "leverage" DOUBLE PRECISION,
    "percentage" DOUBLE PRECISION,
    "stopLoss" DOUBLE PRECISION,
    "takeProfit" DOUBLE PRECISION,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "binanceOrderId" TEXT,
    "executedPrice" DOUBLE PRECISION,
    "executedAmount" DOUBLE PRECISION,
    "executedAt" TIMESTAMP(3),
    "error" TEXT,
    "positionId" TEXT,
    "chatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "symbol" "Symbol" NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "entryAmount" DOUBLE PRECISION NOT NULL,
    "entryLeverage" DOUBLE PRECISION NOT NULL,
    "entryOrderId" TEXT,
    "currentStopLoss" DOUBLE PRECISION,
    "currentTakeProfit" DOUBLE PRECISION,
    "exitPrice" DOUBLE PRECISION,
    "exitAmount" DOUBLE PRECISION,
    "exitOrderId" TEXT,
    "exitReason" TEXT,
    "realizedPnl" DOUBLE PRECISION,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Metrics" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" "ModelType" NOT NULL,
    "metrics" JSONB[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chat_createdAt_idx" ON "Chat"("createdAt");

-- CreateIndex
CREATE INDEX "Trade_symbol_createdAt_idx" ON "Trade"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_status_idx" ON "Trade"("status");

-- CreateIndex
CREATE INDEX "Trade_positionId_idx" ON "Trade"("positionId");

-- CreateIndex
CREATE INDEX "Position_symbol_status_idx" ON "Position"("symbol", "status");

-- CreateIndex
CREATE INDEX "Position_status_idx" ON "Position"("status");

-- CreateIndex
CREATE INDEX "Metrics_model_idx" ON "Metrics"("model");

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
