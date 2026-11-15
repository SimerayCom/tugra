import { proxyToHub } from "../../../../../../lib/hub-stream-proxy";

// The signed relay URLs an AGENT calls during an app move (GET = the target agent pulls one part of a volume, PUT = the
// source agent pushes it) when it reaches the hub through this origin. Each carries one bounded part of volume data, so
// they stream straight through (lib/hub-stream-proxy.ts); the HMAC in the query is the only credential and the hub
// validates it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  return proxyToHub(req, `/api/v1/agent-vx/t/${encodeURIComponent((await ctx.params).id)}`);
}

export async function PUT(req: Request, ctx: Ctx) {
  return proxyToHub(req, `/api/v1/agent-vx/t/${encodeURIComponent((await ctx.params).id)}`);
}
