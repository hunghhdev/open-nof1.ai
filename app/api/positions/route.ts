import { NextResponse } from "next/server";
import { getAccountInformationAndPerformance } from "@/lib/trading/account-information-and-performance";

export const GET = async () => {
  try {
    const initialCapital = Number(process.env.START_MONEY) || 20;
    const accountInfo = await getAccountInformationAndPerformance(
      initialCapital
    );

    // Filter only active positions (contracts > 0)
    const activePositions = accountInfo.positions.filter(
      (position) => Math.abs(position.contracts || 0) > 0
    );

    return NextResponse.json({
      data: activePositions,
      summary: {
        totalPositions: activePositions.length,
        totalValue: accountInfo.currentPositionsValue,
        availableCash: accountInfo.availableCash,
        totalReturn: accountInfo.currentTotalReturn,
      },
    });
  } catch (error) {
    console.error("Error fetching positions:", error);
    return NextResponse.json(
      { error: "Failed to fetch positions" },
      { status: 500 }
    );
  }
};
