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

Deno.test("streamable mcp keeps 看血, speaks the interrupt, and forfeits after 10s", async () => {
  const now = { value: 1_000 };
  const handle = createMcpServer({
    engine: new GameEngine({ now: () => now.value, random: () => 0.1234 }),
    connectionKey: "secret",
    waitHoldMs: 80,
  });
  const say = async (
    id: number,
    sessionId: string,
    name: string,
    args: Record<string, string>,
  ) => {
    const response = await handle(
      new Request("http://localhost/mcp?key=secret", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          accept: "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    const body = await response.json();
    const content = body.result?.content ?? [];
    return {
      text: content.map((block: { text?: string }) => block.text ?? "").join(
        "",
      ),
      phase: String(body.result?.structuredContent?.phase ?? ""),
      code: String(body.result?.structuredContent?.code ?? ""),
    };
  };

  await say(1, "cpu", "submit_lobby_text", {
    device_id: "cpu",
    text: "对电脑",
  });
  await say(2, "cpu", "submit_lobby_text", {
    device_id: "cpu",
    text: "烈焰剑士",
  });
  const ready = await say(3, "cpu", "submit_lobby_text", {
    device_id: "cpu",
    text: "准备",
  });
  assertEquals(ready.text.includes("双方各"), true);
  assertEquals(ready.text.includes("三。二。一。"), false);
  const countdown = await say(31, "cpu", "ack_playback", { device_id: "cpu" });
  assertEquals(countdown.text, "三。二。一。");
  now.value = 1_000 + 3_000 + 3 * 400 + 2_000;
  const blood = await say(4, "cpu", "submit_utterance", {
    device_id: "cpu",
    text: "看血",
  });
  assertEquals(blood.text.includes("中了"), false);
  assertEquals(blood.text.includes("935"), true);
  const pushed = await say(5, "cpu", "wait_event", { device_id: "cpu" });
  assertEquals(pushed.text.includes("中了疾风剑。"), true);
  now.value += 12_000;
  const lost = await say(6, "cpu-2", "submit_utterance", {
    device_id: "cpu",
    text: "看血",
  });
  assertEquals(lost.phase, "REVIEW");
  assertEquals(lost.text.includes("你输了。"), true);

  const online = { value: 1_000 };
  const rooms = createMcpServer({
    engine: new GameEngine({ now: () => online.value, random: () => 0.1234 }),
    connectionKey: "secret",
    waitHoldMs: 80,
  });
  const roomSay = async (
    id: number,
    sessionId: string,
    name: string,
    args: Record<string, string>,
  ) => {
    const response = await rooms(
      new Request("http://localhost/mcp?key=secret", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          accept: "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    const body = await response.json();
    const content = body.result?.content ?? [];
    return content.map((block: { text?: string }) => block.text ?? "").join("");
  };
  const opened = await roomSay(1, "host", "submit_lobby_text", {
    device_id: "host",
    text: "开房间",
  });
  assertEquals(opened.includes("1、2、3、4"), true);
  assertEquals(opened.includes("刚才没听清"), false);
  const joined = await roomSay(2, "guest", "submit_lobby_text", {
    device_id: "guest",
    text: "加入房间，房间号1234",
  });
  assertEquals(joined, "已加入。请选角色并准备。");
  await roomSay(3, "host", "submit_lobby_text", {
    device_id: "host",
    text: "烈焰剑士",
  });
  await roomSay(4, "guest", "submit_lobby_text", {
    device_id: "guest",
    text: "圣光守卫",
  });
  await roomSay(5, "host", "submit_lobby_text", {
    device_id: "host",
    text: "准备",
  });
  const started = await roomSay(6, "guest", "submit_lobby_text", {
    device_id: "guest",
    text: "准备",
  });
  assertEquals(started.includes("双方各"), true);
  assertEquals(started.includes("三。二。一。"), false);
  const openedCountdown = await roomSay(61, "guest", "ack_playback", {
    device_id: "guest",
  });
  assertEquals(openedCountdown.includes("三。二。一。"), true);
  online.value += 3_000;
  await roomSay(7, "guest", "begin_cast", { device_id: "guest" });
  const slash = await roomSay(8, "host", "submit_utterance", {
    device_id: "host",
    text: "疾风剑",
  });
  assertEquals(slash.includes("疾风剑命中。"), true);
  assertEquals(slash.includes("你1000血。"), true);
  assertEquals(slash.includes("对手935血。"), true);
  const interrupted = await roomSay(9, "guest", "submit_utterance", {
    device_id: "guest",
    text: "守阵重击",
  });
  assertEquals(interrupted.includes("吟唱被打断。"), true);
  assertEquals(interrupted.includes("中了疾风剑。"), true);
  assertEquals(interrupted.includes("你935血。"), true);
  const conceded = await roomSay(10, "host", "submit_utterance", {
    device_id: "host",
    text: "投降",
  });
  assertEquals(conceded.includes("你输了。"), true);
  assertEquals(conceded.includes("刚才没听清"), false);
  const won = await roomSay(11, "guest", "submit_utterance", {
    device_id: "guest",
    text: "看血",
  });
  assertEquals(won.includes("你赢了。"), true);
  assertEquals(won.includes("你935血。"), true);
});
