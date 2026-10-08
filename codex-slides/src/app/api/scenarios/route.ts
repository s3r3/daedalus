import { NextResponse } from "next/server";
import {
  FEATURED_SCENARIOS,
  PRESENTATION_SCENARIOS,
  SCENARIO_GROUPS,
} from "@/lib/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Product-owned scenario catalog shared by the Browser, Agent Skill, and MCP. */
export async function GET() {
  return NextResponse.json({
    groups: SCENARIO_GROUPS,
    scenarios: PRESENTATION_SCENARIOS,
    featuredIds: FEATURED_SCENARIOS.map((scenario) => scenario.id),
  });
}
