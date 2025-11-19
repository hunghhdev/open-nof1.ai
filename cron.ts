import cron from "node-cron";
import jwt from "jsonwebtoken";

const runMetricsInterval = async () => {
  try {
    console.log("Running task 20 seconds metrics interval");
    const token = jwt.sign(
      {
        sub: "cron-token",
      },
      process.env.CRON_SECRET_KEY || ""
    );

    await fetch(
      `${process.env.NEXT_PUBLIC_URL}/api/cron/20-seconds-metrics-interval?token=${token}`,
      {
        method: "GET",
      }
    );

    console.log("20 seconds metrics interval executed");
  } catch (error) {
    console.error("Failed to run 20 seconds metrics interval", error);
  }
};

// every 20 seconds
cron.schedule("*/10 * * * * *", async () => {
  await runMetricsInterval();
});

const runChatInterval = async () => {
  try {
    console.log("Running task every 5 minutes");
    const token = jwt.sign(
      {
        sub: "cron-token",
      },
      process.env.CRON_SECRET_KEY || ""
    );

    await fetch(
      `${process.env.NEXT_PUBLIC_URL}/api/cron/3-minutes-run-interval?token=${token}`,
      {
        method: "GET",
      }
    );
  } catch (error) {
    console.error("Failed to run 5 minutes chat interval", error);
  }
};

// every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  await runChatInterval();
});

await runChatInterval();
