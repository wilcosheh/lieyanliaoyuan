import { assertEquals } from "@std/assert";
import { GameEngine } from "../../engine/service/game.ts";
import { createMcpServer } from "./server.ts";

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(marker)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  return text;
}

Deno.test("mcp rejects a missing connection key", async () => {
  const handle = createMcpServer({
    engine: new GameEngine(),
    connectionKey: "secret",
  });
  const denied = await handle(new Request("http://localhost/mcp"));
  assertEquals(denied.status, 401);
});

Deno.test("mcp returns the lobby line on the parked tool call", async () => {
  const handle = createMcpServer({
    engine: new GameEngine(),
    connectionKey: "secret",
  });
  const sse = await handle(
    new Request("http://localhost/mcp", {
      headers: { authorization: "Bearer secret", accept: "text/event-stream" },
    }),
  );
  const reader = sse.body!.getReader();
  const opened = await readUntil(reader, "sessionId=");
  const sessionId = opened.match(/sessionId=([0-9a-f-]+)/)?.[1] ?? "";
  const posted = handle(
    new Request(
      `http://localhost/mcp/message?sessionId=${sessionId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "submit_lobby_text",
            arguments: { device_id: "device-1", text: "烈焰剑士" },
          },
        }),
      },
    ),
  );
  const [accepted, message] = await Promise.all([
    posted,
    readUntil(reader, "event: message"),
  ]);
  assertEquals(accepted.status, 202);
  assertEquals(message.includes("已选烈焰剑士。"), true);
  assertEquals(message.includes('"id":7'), true);
  await reader.cancel();
});

Deno.test("endpoint keeps the public base and the connection key", async () => {
  const previous = Deno.env.get("PUBLIC_BASE_URL");
  Deno.env.set(
    "PUBLIC_BASE_URL",
    "https://example.supabase.co/functions/v1/game/mcp",
  );
  try {
    const handle = createMcpServer({
      engine: new GameEngine(),
      connectionKey: "secret",
    });
    const sse = await handle(
      new Request("http://internal/mcp?key=secret", {
        headers: { accept: "text/event-stream" },
      }),
    );
    const reader = sse.body!.getReader();
    const opened = await readUntil(reader, "sessionId=");
    assertEquals(
      opened.includes(
        "https://example.supabase.co/functions/v1/game/mcp/message?sessionId=",
      ),
      true,
    );
    assertEquals(opened.includes("key=secret"), true);
    await reader.cancel();
  } finally {
    if (previous === undefined) Deno.env.delete("PUBLIC_BASE_URL");
    else Deno.env.set("PUBLIC_BASE_URL", previous);
  }
});

Deno.test("a cancelled wait is rebound to the next wait_event", async () => {
  const handle = createMcpServer({
    engine: new GameEngine({ random: () => 0.1234 }),
    connectionKey: "secret",
  });
  const sse = await handle(
    new Request("http://localhost/mcp", {
      headers: { authorization: "Bearer secret", accept: "text/event-stream" },
    }),
  );
  const reader = sse.body!.getReader();
  const opened = await readUntil(reader, "sessionId=");
  const sessionId = opened.match(/sessionId=([0-9a-f-]+)/)?.[1] ?? "";
  const post = (id: number | null, method: string, params: unknown) =>
    handle(
      new Request(`http://localhost/mcp/message?sessionId=${sessionId}`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
    );
  await post(1, "tools/call", {
    name: "submit_lobby_text",
    arguments: { device_id: "host", text: "开房间" },
  });
  await readUntil(reader, "房间号 1、2、3、4");
  await post(2, "tools/call", {
    name: "wait_event",
    arguments: { device_id: "host" },
  });
  await post(null, "notifications/cancelled", { requestId: 2 });
  await post(3, "tools/call", {
    name: "submit_lobby_text",
    arguments: '{"device_id":"guest","text":"1234"}',
  });
  await readUntil(reader, "已加入。请选角色并准备。");
  await post(4, "tools/call", {
    name: "wait_event",
    arguments: { device_id: "host" },
  });
  const rebound = await readUntil(reader, "对手来了。请选角色并准备。");
  assertEquals(rebound.includes('"id":4'), true);
  await reader.cancel();
});

Deno.test("product name is rejected as device_id", async () => {
  const handle = createMcpServer({
    engine: new GameEngine(),
    connectionKey: "secret",
  });
  const sse = await handle(
    new Request("http://localhost/mcp", {
      headers: { authorization: "Bearer secret", accept: "text/event-stream" },
    }),
  );
  const reader = sse.body!.getReader();
  const opened = await readUntil(reader, "sessionId=");
  const sessionId = opened.match(/sessionId=([0-9a-f-]+)/)?.[1] ?? "";
  const posted = handle(
    new Request(`http://localhost/mcp/message?sessionId=${sessionId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "submit_lobby_text",
          arguments: { device_id: "烈焰燎原", text: "人机对战" },
        },
      }),
    }),
  );
  const [accepted, message] = await Promise.all([
    posted,
    readUntil(reader, "设备号无效"),
  ]);
  assertEquals(accepted.status, 202);
  assertEquals(message.includes("设备号无效。请改用提示词里的设备号。"), true);
  assertEquals(message.includes("对手是"), false);
  await reader.cancel();
});

function toolCall(
  id: number,
  name: string,
  args: Record<string, string>,
): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

Deno.test("an idle wait_event returns json instead of text/plain", async () => {
  const handle = createMcpServer({
    engine: new GameEngine(),
    connectionKey: "secret",
    waitHoldMs: 40,
  });
  const res = await handle(toolCall(1, "wait_event", { device_id: "小贾" }));
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  const body = await res.json();
  assertEquals(body.result.content[0].text, "。");
  assertEquals(body.result.structuredContent.wait, true);
});

Deno.test("the next wait_event still hears an opponent who arrived after the heartbeat", async () => {
  const handle = createMcpServer({
    engine: new GameEngine({ random: () => 0.1234 }),
    connectionKey: "secret",
    waitHoldMs: 40,
  });
  await handle(toolCall(1, "submit_lobby_text", {
    device_id: "host",
    text: "开房间",
  }));
  const idle = await handle(toolCall(2, "wait_event", { device_id: "host" }));
  assertEquals((await idle.json()).result.content[0].text, "。");
  const guest = await handle(toolCall(3, "submit_lobby_text", {
    device_id: "guest",
    text: "1234",
  }));
  assertEquals(
    (await guest.json()).result.content[0].text,
    "已加入。请选角色并准备。",
  );
  const again = await handle(toolCall(4, "wait_event", { device_id: "host" }));
  assertEquals(
    (await again.json()).result.content[0].text,
    "对手来了。请选角色并准备。",
  );
});
