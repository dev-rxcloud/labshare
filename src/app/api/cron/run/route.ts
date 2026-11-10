import { NextResponse } from "next/server";
import { runAutomation } from "@/lib/services/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Runs all billing/booking automation. Call at least hourly from a scheduler:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/run
 * (Vercel Cron sends this header automatically when CRON_SECRET is set.)
 */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runAutomation(new Date());
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
