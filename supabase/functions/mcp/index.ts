import { createDefaultCtx, handle } from "../../../src/mcp/handler.ts";

const ctx = createDefaultCtx();

Deno.serve((req) => handle(req, ctx));
