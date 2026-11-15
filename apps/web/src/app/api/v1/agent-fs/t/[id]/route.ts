import { proxyToHub } from "../../../../../../lib/hub-stream-proxy";

// The signed transfer URLs an AGENT calls (GET pulls an upload, PUT pushes a download) when it reaches the hub through
// this origin. They carry whole file bodies, so they stream straight through (lib/hub-stream-proxy.ts); the HMAC in
// the query is the only credential and the hub validates it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  return proxyToHub(req, `/api/v1/agent-fs/t/${encodeURIComponent((await ctx.params).id)}`);
}

export async function PUT(req: Request, ctx: Ctx) {
  return proxyToHub(req, `/api/v1/agent-fs/t/${encodeURIComponent((await ctx.params).id)}`);
}
