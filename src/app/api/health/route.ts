import { NextResponse } from "next/server";
import { buildHealthPayload } from "./payload";

// Process-level health only: no DB, provider, or Telegram calls here.
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(buildHealthPayload(), { status: 200 });
}
