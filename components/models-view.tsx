"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChevronDown, TrendingUp, TrendingDown, Minus } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Trade {
  id: string;
  symbol: string;
  operation: "Buy" | "Sell" | "Hold";
  leverage?: number | null;
  amount?: number | null;
  pricing?: number | null;
  percentage?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  createdAt: string;
}

interface Chat {
  id: string;
  model: string;
  chat: string;
  reasoning: string;
  userPrompt: string;
  trades: Trade[];
  createdAt: string;
  updatedAt: string;
}

interface Position {
  symbol: string;
  contracts: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  leverage: number;
  notional: number;
  side: "long" | "short";
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
}

interface PositionsData {
  data: Position[];
  summary: {
    totalPositions: number;
    totalValue: number;
    availableCash: number;
    totalReturn: number;
  };
}

type TabType = "completed-trades" | "model-chat" | "positions";

export function ModelsView() {
  const [activeTab, setActiveTab] = useState<TabType>("model-chat");
  const [chats, setChats] = useState<Chat[]>([]);
  const [positions, setPositions] = useState<PositionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [positionsLoading, setPositionsLoading] = useState(true);
  const [expandedChatId, setExpandedChatId] = useState<string | null>(null);

  const fetchChats = useCallback(async () => {
    try {
      const response = await fetch("/api/model/chat");
      if (!response.ok) return;

      const data = await response.json();
      setChats(data.data || []);
      setLoading(false);
    } catch (err) {
      console.error("Error fetching chats:", err);
      setLoading(false);
    }
  }, []);

  const fetchPositions = useCallback(async () => {
    try {
      const response = await fetch("/api/positions");
      if (!response.ok) return;

      const data = await response.json();
      setPositions(data);
      setPositionsLoading(false);
    } catch (err) {
      console.error("Error fetching positions:", err);
      setPositionsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChats();
    fetchPositions();
    const chatsInterval = setInterval(fetchChats, 30000);
    const positionsInterval = setInterval(fetchPositions, 30000);
    return () => {
      clearInterval(chatsInterval);
      clearInterval(positionsInterval);
    };
  }, [fetchChats, fetchPositions]);

  // 只获取 Buy 和 Sell 操作的交易
  const completedTrades = chats.flatMap((chat) =>
    chat.trades
      .filter((t) => t.operation === "Buy" || t.operation === "Sell")
      .map((t) => ({ ...t, chatId: chat.id, model: chat.model }))
  );

  const renderOperationIcon = (operation: string) => {
    switch (operation) {
      case "Buy":
        return <TrendingUp className="h-4 w-4 text-green-500" />;
      case "Sell":
        return <TrendingDown className="h-4 w-4 text-red-500" />;
      case "Hold":
        return <Minus className="h-4 w-4 text-yellow-500" />;
      default:
        return null;
    }
  };

  const renderCompletedTrades = () => {
    if (loading) {
      return <div className="text-center py-8 text-sm">Loading trades...</div>;
    }

    if (completedTrades.length === 0) {
      return (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No completed trades yet
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <div className="text-xs text-muted-foreground mb-2">
          {completedTrades.length} completed trade
          {completedTrades.length > 1 ? "s" : ""}
        </div>
        {completedTrades.map((trade, idx) => (
          <Card key={`${trade.id}-${idx}`} className="overflow-hidden">
            <CardContent className="p-4">
              {/* Header with operation */}
              <div className="flex items-center justify-between mb-3 pb-3 border-b">
                <div className="flex items-center gap-2">
                  {renderOperationIcon(trade.operation)}
                  <span className="font-bold text-base">
                    {trade.operation.toUpperCase()}
                  </span>
                  <span className="font-mono font-bold text-base">
                    {trade.symbol}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(trade.createdAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </div>

              {/* Trade details grid */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                {/* Price */}
                {trade.pricing && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground font-medium">
                      {trade.operation === "Buy" ? "Entry Price" : "Exit Price"}
                    </div>
                    <div className="font-mono font-bold text-base">
                      $
                      {trade.pricing.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </div>
                  </div>
                )}

                {/* Amount */}
                {trade.amount && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground font-medium">
                      Amount
                    </div>
                    <div className="font-mono font-semibold">
                      {trade.amount}{" "}
                      {trade.symbol?.includes("/") ? "units" : trade.symbol}
                    </div>
                  </div>
                )}

                {/* Percentage (for Sell) */}
                {trade.operation === "Sell" && trade.percentage && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground font-medium">
                      % to Sell
                    </div>
                    <div className="font-mono font-semibold text-orange-600">
                      {trade.percentage}%
                    </div>
                  </div>
                )}

                {/* Leverage */}
                {trade.leverage && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground font-medium">
                      Leverage
                    </div>
                    <div className="font-mono font-semibold text-purple-600">
                      {trade.leverage}x
                    </div>
                  </div>
                )}

                {/* Total Value */}
                {trade.pricing && trade.amount && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground font-medium">
                      Total Value
                    </div>
                    <div className="font-mono font-bold text-base">
                      $
                      {(trade.pricing * trade.amount).toLocaleString(
                        undefined,
                        {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        }
                      )}
                    </div>
                  </div>
                )}

                {/* Stop Loss */}
                {trade.stopLoss && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground font-medium">
                      Stop Loss
                    </div>
                    <div className="font-mono font-semibold text-red-500">
                      ${trade.stopLoss.toLocaleString()}
                    </div>
                  </div>
                )}

                {/* Take Profit */}
                {trade.takeProfit && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground font-medium">
                      Take Profit
                    </div>
                    <div className="font-mono font-semibold text-green-500">
                      ${trade.takeProfit.toLocaleString()}
                    </div>
                  </div>
                )}
              </div>

              {/* Model info at bottom */}
              <div className="mt-3 pt-3 border-t">
                <div className="text-xs text-muted-foreground">
                  Model:{" "}
                  <span className="font-medium text-foreground">
                    {trade.model}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  };

  const renderModelChat = () => {
    if (loading) {
      return <div className="text-center py-8 text-sm">Loading chats...</div>;
    }

    if (chats.length === 0) {
      return (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No chat history yet
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {chats.map((chat) => {
          const isExpanded = expandedChatId === chat.id;
          const decisions = chat.trades;

          return (
            <Card key={chat.id} className="overflow-hidden max-w-[600px]">
              {/* Collapsed Header */}
              <div className="p-4">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="font-semibold text-sm">{chat.model}</h3>
                      <span className="text-xs text-muted-foreground">
                        • {decisions.length} decision
                        {decisions.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    {/* Chat preview with markdown */}
                    <div
                      className={`prose prose-sm max-w-none dark:prose-invert text-xs ${
                        isExpanded ? "" : "line-clamp-2"
                      }`}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {chat.chat}
                      </ReactMarkdown>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(chat.createdAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>

                {/* Expanded Content */}
                {isExpanded && (
                  <div className="mt-4 pt-4 border-t space-y-4">
                    {/* User Prompt */}
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-2">
                        <span className="text-sm">📝</span>
                        User Prompt
                      </div>
                      <div className="bg-muted/50 rounded-lg p-3 max-h-40 overflow-y-auto">
                        <div className="prose prose-sm max-w-none dark:prose-invert text-xs">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {chat.userPrompt}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>

                    {/* Chain of Thought */}
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-2">
                        <span className="text-sm">🧠</span>
                        Chain of Thought
                      </div>
                      <div className="bg-muted/50 rounded-lg p-3 max-h-40 overflow-y-auto">
                        <div className="prose prose-sm max-w-none dark:prose-invert text-xs">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {chat.reasoning}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>

                    {/* Decisions */}
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-2">
                        <span className="text-sm">⚡</span>
                        Trading Decisions
                      </div>
                      <div className="space-y-2">
                        {decisions.map((decision, idx) => (
                          <div
                            key={idx}
                            className={`rounded-lg p-3 border-l-4 ${
                              decision.operation === "Buy"
                                ? "bg-green-50 dark:bg-green-950/20 border-green-500"
                                : decision.operation === "Sell"
                                ? "bg-red-50 dark:bg-red-950/20 border-red-500"
                                : "bg-yellow-50 dark:bg-yellow-950/20 border-yellow-500"
                            }`}
                          >
                            {/* Decision header */}
                            <div className="flex items-center gap-2 mb-2">
                              {renderOperationIcon(decision.operation)}
                              <span className="font-bold text-sm">
                                {decision.operation.toUpperCase()}
                              </span>
                              <span className="font-mono font-bold text-sm">
                                {decision.symbol}
                              </span>
                            </div>

                            {/* Decision details */}
                            <div className="space-y-1.5 text-xs">
                              {decision.pricing && (
                                <div className="flex justify-between items-center">
                                  <span className="text-muted-foreground">
                                    {decision.operation === "Buy"
                                      ? "Entry Price:"
                                      : decision.operation === "Sell"
                                      ? "Exit Price:"
                                      : "Current Price:"}
                                  </span>
                                  <span className="font-mono font-semibold">
                                    ${decision.pricing.toLocaleString()}
                                  </span>
                                </div>
                              )}
                              {decision.amount && (
                                <div className="flex justify-between items-center">
                                  <span className="text-muted-foreground">
                                    Amount:
                                  </span>
                                  <span className="font-mono font-semibold">
                                    {decision.amount}
                                  </span>
                                </div>
                              )}
                              {decision.operation === "Sell" && decision.percentage && (
                                <div className="flex justify-between items-center">
                                  <span className="text-muted-foreground">
                                    % to Sell:
                                  </span>
                                  <span className="font-mono font-semibold text-orange-600">
                                    {decision.percentage}%
                                  </span>
                                </div>
                              )}
                              {decision.leverage && (
                                <div className="flex justify-between items-center">
                                  <span className="text-muted-foreground">
                                    Leverage:
                                  </span>
                                  <span className="font-mono font-semibold text-purple-600">
                                    {decision.leverage}x
                                  </span>
                                </div>
                              )}
                              {decision.pricing && decision.amount && (
                                <div className="flex justify-between items-center pt-1.5 mt-1.5 border-t border-current/20">
                                  <span className="text-muted-foreground font-semibold">
                                    Total:
                                  </span>
                                  <span className="font-mono font-bold">
                                    $
                                    {(
                                      decision.pricing * decision.amount
                                    ).toLocaleString()}
                                  </span>
                                </div>
                              )}
                              {(decision.stopLoss || decision.takeProfit) && (
                                <div className="pt-1.5 mt-1.5 border-t border-current/20 space-y-1">
                                  {decision.stopLoss && (
                                    <div className="flex justify-between items-center">
                                      <span className="text-muted-foreground">
                                        Stop Loss:
                                      </span>
                                      <span className="font-mono font-semibold text-red-500">
                                        ${decision.stopLoss.toLocaleString()}
                                      </span>
                                    </div>
                                  )}
                                  {decision.takeProfit && (
                                    <div className="flex justify-between items-center">
                                      <span className="text-muted-foreground">
                                        Take Profit:
                                      </span>
                                      <span className="font-mono font-semibold text-green-500">
                                        ${decision.takeProfit.toLocaleString()}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Expand/Collapse button */}
              <button
                onClick={() => setExpandedChatId(isExpanded ? null : chat.id)}
                className="w-full border-t px-4 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors flex items-center justify-center gap-2"
              >
                <span>{isExpanded ? "Show less" : "Expand more"}</span>
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${
                    isExpanded ? "rotate-180" : ""
                  }`}
                />
              </button>
            </Card>
          );
        })}
      </div>
    );
  };

  const renderPositions = () => {
    if (positionsLoading) {
      return (
        <div className="text-center py-8 text-sm">Loading positions...</div>
      );
    }

    if (!positions || positions.data.length === 0) {
      return (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No active positions
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {/* Summary Card */}
        {positions.summary && (
          <Card className="bg-muted/30">
            <CardContent className="p-3">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="text-muted-foreground mb-1">
                    Total Positions
                  </div>
                  <div className="font-semibold">
                    {positions.summary.totalPositions}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-1">
                    Available Cash
                  </div>
                  <div className="font-semibold font-mono">
                    ${positions.summary.availableCash.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-1">
                    Position Value
                  </div>
                  <div className="font-semibold font-mono">
                    ${positions.summary.totalValue.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-1">Total Return</div>
                  <div
                    className={`font-semibold font-mono ${
                      positions.summary.totalReturn >= 0
                        ? "text-green-500"
                        : "text-red-500"
                    }`}
                  >
                    {(positions.summary.totalReturn * 100).toFixed(2)}%
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Positions List */}
        {positions.data.map((position, index) => {
          const pnlPercent =
            ((position.markPrice - position.entryPrice) /
              position.entryPrice) *
            100;
          const isProfitable = position.unrealizedPnl >= 0;
          const slDistance = position.stopLossPrice
            ? ((position.stopLossPrice - position.entryPrice) /
                position.entryPrice) *
              100
            : null;
          const tpDistance = position.takeProfitPrice
            ? ((position.takeProfitPrice - position.entryPrice) /
                position.entryPrice) *
              100
            : null;

          return (
            <Card key={index} className="overflow-hidden">
              <CardContent className="p-4">
                {/* Header */}
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <div className="font-semibold text-base">
                      {position.symbol}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {position.side.toUpperCase()} {position.leverage}x
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className={`text-sm font-bold ${
                        isProfitable ? "text-green-500" : "text-red-500"
                      }`}
                    >
                      {isProfitable ? "+" : ""}$
                      {position.unrealizedPnl.toFixed(2)}
                    </div>
                    <div
                      className={`text-xs ${
                        isProfitable ? "text-green-500" : "text-red-500"
                      }`}
                    >
                      {pnlPercent >= 0 ? "+" : ""}
                      {pnlPercent.toFixed(2)}%
                    </div>
                  </div>
                </div>

                {/* Price Info */}
                <div className="space-y-2 mb-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Entry:</span>
                    <span className="font-mono font-semibold">
                      ${position.entryPrice.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Current:</span>
                    <span className="font-mono font-semibold">
                      ${position.markPrice.toLocaleString()}
                    </span>
                  </div>
                </div>

                {/* Stop Loss & Take Profit */}
                <div className="space-y-2 mb-3 text-xs border-t pt-2">
                  {position.stopLossPrice && (
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Stop Loss:</span>
                      <div className="text-right">
                        <div className="font-mono font-semibold text-red-500">
                          ${position.stopLossPrice.toLocaleString()}
                        </div>
                        {slDistance !== null && (
                          <div className="text-red-500">
                            {slDistance.toFixed(2)}%
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {position.takeProfitPrice && (
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">
                        Take Profit:
                      </span>
                      <div className="text-right">
                        <div className="font-mono font-semibold text-green-500">
                          ${position.takeProfitPrice.toLocaleString()}
                        </div>
                        {tpDistance !== null && (
                          <div className="text-green-500">
                            +{tpDistance.toFixed(2)}%
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Position Details */}
                <div className="grid grid-cols-2 gap-2 text-xs border-t pt-2">
                  <div>
                    <div className="text-muted-foreground">Size</div>
                    <div className="font-mono">
                      {position.contracts} {position.symbol.split("/")[0]}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Notional</div>
                    <div className="font-mono">
                      ${position.notional.toFixed(2)}
                    </div>
                  </div>
                  {position.liquidationPrice && (
                    <div className="col-span-2">
                      <div className="text-muted-foreground">Liquidation</div>
                      <div className="font-mono text-red-400">
                        ${position.liquidationPrice.toLocaleString()}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    );
  };

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader className="pb-3 flex-shrink-0">
        <CardTitle className="text-lg">Model Activity</CardTitle>
        <CardDescription className="text-xs">
          Real-time trading decisions and AI reasoning
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col px-4 pb-4 min-h-0">
        {/* Tabs */}
        <div className="flex gap-2 border-b mb-4 flex-shrink-0">
          <button
            onClick={() => setActiveTab("model-chat")}
            className={`pb-2 px-3 text-xs font-medium transition-colors ${
              activeTab === "model-chat"
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            CHAT
          </button>
          <button
            onClick={() => setActiveTab("completed-trades")}
            className={`pb-2 px-3 text-xs font-medium transition-colors ${
              activeTab === "completed-trades"
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            TRADES
          </button>
          <button
            onClick={() => setActiveTab("positions")}
            className={`pb-2 px-3 text-xs font-medium transition-colors ${
              activeTab === "positions"
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            POSITIONS
          </button>
        </div>

        {/* Content - Scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0 -mx-4 px-4">
          {activeTab === "model-chat" && renderModelChat()}
          {activeTab === "completed-trades" && renderCompletedTrades()}
          {activeTab === "positions" && renderPositions()}
        </div>
      </CardContent>
    </Card>
  );
}
