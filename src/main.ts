import { handle } from "./adapter/mcp/server.ts";

const port = Number(Deno.env.get("PORT") ?? "8787");

Deno.serve({ port, hostname: "0.0.0.0" }, handle);
console.log(`lieyanliaoyuan listening on :${port}/mcp`);
