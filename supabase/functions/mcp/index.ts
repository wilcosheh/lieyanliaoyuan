import { createDefaultCtx, handle } from "../../../src/adapter/mcp/handler.ts";

const ctx = createDefaultCtx();

Deno.serve((req) => handle(req, ctx));
