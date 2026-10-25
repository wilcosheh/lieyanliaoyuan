import { createDefaultCtx, handle } from "./adapter/mcp/handler.ts";

const ctx = createDefaultCtx();
const port = Number(Deno.env.get("PORT") ?? "8787");

Deno.serve({ port, hostname: "0.0.0.0" }, (req) => handle(req, ctx));
console.log(`lieyanliaoyuan listening on :${port}/mcp`);
