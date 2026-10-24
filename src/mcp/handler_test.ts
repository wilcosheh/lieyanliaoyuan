import { assert, assertEquals } from "@std/assert";
import { handle, type ServerCtx } from "./handler.ts";
import { MemoryStore } from "./store.ts";

function ctx(): ServerCtx {
  return {
    store: new MemoryStore(),
    timeScale: 1,
    lookup: () => Promise.resolve(null),
    audioEnabled: false,
  };
}

function post(method: string, params: unknown, id: number | null = 1): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "web-demo",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

function rpcBody(
  raw: string,
): {
  result: { serverInfo?: { name: string }; content?: Array<{ text: string }> };
} {
  const line = raw.split("\n").find((item) => item.startsWith("data: "));
  if (!line) throw new Error(raw);
  return JSON.parse(line.slice("data: ".length));
}

Deno.test("Streamable HTTP 的 initialize 用 SSE 返回结果", async () => {
  const res = await handle(post("initialize", {}), ctx());
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("mcp-session-id"), "web-demo");
  assert(res.headers.get("content-type")?.includes("text/event-stream"));
  const body = rpcBody(await res.text());
  assertEquals(body.result.serverInfo?.name, "lieyanliaoyuan");
});

Deno.test("网页会话没有设备头时，结果回到 endpoint 的 sessionId", async () => {
  const store = new MemoryStore();
  const server = ctx();
  server.store = store;
  const ctrl = new AbortController();
  const opened = await handle(
    new Request("https://example.com/mcp", { signal: ctrl.signal }),
    server,
  );
  const reader = opened.body?.getReader();
  if (!reader) throw new Error("missing sse body");
  const decoder = new TextDecoder();
  let raw = "";
  while (!raw.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    raw += decoder.decode(chunk.value);
  }
  const endpoint = raw.split("\n").find((line) => line.startsWith("data: "));
  if (!endpoint) throw new Error(raw);
  const target = endpoint.slice("data: ".length);
  const posted = await handle(
    new Request(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linx-session-id": "web-session",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: {},
      }),
    }),
    server,
  );
  assertEquals(posted.status, 202);
  const deadline = Date.now() + 2000;
  while (!raw.includes("lieyanliaoyuan") && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    raw += decoder.decode(chunk.value);
  }
  ctrl.abort();
  assert(raw.includes("event: message"));
  assert(raw.includes("lieyanliaoyuan"));
  const leaked = await store.drain("web-session");
  assertEquals(leaked.length, 0);
});

Deno.test("正在等结果的信箱，SSE 抽不走", async () => {
  const store = new MemoryStore();
  await store.hold("dev");
  await store.deliver("dev", {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "对手来了。说准备。" }] },
  });
  assertEquals(await store.drain("dev"), []);
  const mine = await store.drain("dev", true);
  assertEquals(mine.length, 1);
  await store.release("dev");
  await store.deliver("dev", {
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text: "。" }] },
  });
  assertEquals((await store.drain("dev")).length, 1);
});

Deno.test("Streamable HTTP 的 create_room 直接返回房间号", async () => {
  const res = await handle(
    post("tools/call", { name: "create_room", arguments: {} }),
    ctx(),
  );
  assertEquals(res.status, 200);
  const body = rpcBody(await res.text());
  const text = body.result.content?.[0]?.text ?? "";
  assert(/房间\d{4}/.test(text));
});
