import { NextRequest, NextResponse } from "next/server";
import { run } from "@/lib/ai/run";

export const maxDuration = 300; // 5 minutes timeout

export async function GET(request: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get("authorization");
    const secret = request.nextUrl.searchParams.get("secret");

    const cronSecret = process.env.CRON_SECRET_KEY;

    if (authHeader !== `Bearer ${cronSecret}` && secret !== cronSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("[CRON] Starting trading loop...");

    const startMoney = parseFloat(process.env.START_MONEY || "20");
    await run(startMoney);

    console.log("[CRON] Trading loop completed successfully");

    return NextResponse.json({
      success: true,
      message: "Trading loop executed successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[CRON] Trading loop failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
