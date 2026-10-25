import { assertEquals } from "@std/assert";
import { GameEngine } from "../../engine/service/game.ts";
import { RestHub } from "./rest_hub.ts";

type Row = Record<string, unknown>;

/** 内存里的 PostgREST，按设备分表存引擎快照。 */
function memoryRest() {
  const tables = new Map<string, Row[]>();
  const ensure = (table: string) => {
    let rows = tables.get(table);
    if (!rows) {
      rows = [];
      tables.set(table, rows);
    }
    return rows;
  };

  const request: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const prefer = String(
      (init?.headers as Record<string, string> | undefined)?.Prefer ?? "",
    );
    const rows = ensure(table);

    if (method === "GET") {
      let matched = [...rows];
      for (const [key, raw] of url.searchParams) {
        if (key === "select" || key === "order" || key === "limit") continue;
        const value = decodeURIComponent(raw);
        if (value.startsWith("eq.")) {
          const want = decodeURIComponent(value.slice(3));
          matched = matched.filter((row) => String(row[key]) === want);
          continue;
        }
        if (value.startsWith("neq.")) {
          const want = decodeURIComponent(value.slice(4));
          matched = matched.filter((row) => String(row[key]) !== want);
        }
      }
      const select = url.searchParams.get("select");
      if (select && select !== "*") {
        const fields = select.split(",");
        matched = matched.map((row) => {
          const next: Row = {};
          for (const field of fields) next[field] = row[field];
          return next;
        });
      }
      const limit = url.searchParams.get("limit");
      if (limit) matched = matched.slice(0, Number(limit));
      return Promise.resolve(
        new Response(JSON.stringify(matched), { status: 200 }),
      );
    }

    if (method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) as Row[] : [];
      const onConflict = url.searchParams.get("on_conflict");
      for (const item of body) {
        if (onConflict && prefer.includes("resolution=merge-duplicates")) {
          const fields = onConflict.split(",");
          const index = rows.findIndex((row) =>
            fields.every((field) => row[field] === item[field])
          );
          if (index >= 0) {
            rows[index] = { ...rows[index], ...item };
            continue;
          }
        }
        if (table === "ly_mcp_pending" || table === "ly_mcp_message") {
          item.id = rows.length + 1;
        }
        rows.push(item);
      }
      if (prefer.includes("return=minimal")) {
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 201 }),
      );
    }

    if (method === "DELETE") {
      let next = [...rows];
      for (const [key, raw] of url.searchParams) {
        if (key === "select") continue;
        const value = decodeURIComponent(raw);
        if (value.startsWith("eq.")) {
          const want = decodeURIComponent(value.slice(3));
          next = next.filter((row) => String(row[key]) !== want);
        }
      }
      tables.set(table, next);
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    return Promise.resolve(new Response("method", { status: 405 }));
  };

  return {
    url: "http://rest.local",
    key: "service",
    request,
    tables,
  };
}

Deno.test("RestHub joins the host room code across device rows", async () => {
  const rest = memoryRest();
  const hub = new RestHub(rest, () => true, () => true);
  const hostEngine = new GameEngine({ random: () => 0.9518 });
  const opened = await hostEngine.handle({
    deviceId: "房主",
    commandId: "open",
    tool: "submit_lobby_text",
    text: "开房间",
    terminal: "voice",
  });
  assertEquals(opened.caller?.say.includes("9、5、1、8"), true);
  await rest.request(
    "http://rest.local/rest/v1/ly_device_engine?on_conflict=device_key",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{
        device_key: "房主",
        state: hostEngine.exportState(),
        updated_at: new Date().toISOString(),
      }]),
    },
  );

  const join = await hub.call({
    sessionId: "s-guest",
    rpcId: 1,
    command: {
      deviceId: "小贾",
      commandId: "join",
      tool: "submit_lobby_text",
      text: "加入房间9518。",
      terminal: "voice",
    },
  });
  const body = join as {
    result: { structuredContent: { say: string; code: string } };
  };
  assertEquals(body.result.structuredContent.say, "已加入。请选角色并准备。");
  assertEquals(body.result.structuredContent.code, "ACCEPTED");

  const guestRow = rest.tables.get("ly_device_engine")?.find((row) =>
    row.device_key === "小贾"
  );
  const hostRow = rest.tables.get("ly_device_engine")?.find((row) =>
    row.device_key === "房主"
  );
  const guestState = guestRow?.state as {
    rooms: Array<{ code: string; guestKey: string | null }>;
  };
  const hostState = hostRow?.state as {
    rooms: Array<{ code: string; guestKey: string | null }>;
  };
  assertEquals(guestState.rooms[0]?.code, "9518");
  assertEquals(guestState.rooms[0]?.guestKey, "小贾");
  assertEquals(hostState.rooms[0]?.guestKey, "小贾");
});

Deno.test("RestHub practice with a leftover open room skips the peer table scan", async () => {
  const rest = memoryRest();
  let peerScans = 0;
  const counting: typeof fetch = (input, init) => {
    const url = String(input);
    if (
      url.includes("ly_device_engine") && url.includes("device_key=neq.") &&
      (init?.method ?? "GET").toUpperCase() === "GET"
    ) {
      peerScans += 1;
    }
    return rest.request(input, init);
  };
  const hub = new RestHub(
    { url: rest.url, key: rest.key, request: counting },
    () => true,
    () => true,
  );
  const hostEngine = new GameEngine({ random: () => 0.1234 });
  await hostEngine.handle({
    deviceId: "小易方",
    commandId: "open",
    tool: "submit_lobby_text",
    text: "开房间",
    terminal: "voice",
  });
  await rest.request(
    "http://rest.local/rest/v1/ly_device_engine?on_conflict=device_key",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{
        device_key: "小易方",
        state: hostEngine.exportState(),
        updated_at: new Date().toISOString(),
      }]),
    },
  );

  const practiced = await hub.call({
    sessionId: "s-practice",
    rpcId: 1,
    command: {
      deviceId: "小易方",
      commandId: "practice",
      tool: "submit_lobby_text",
      text: "练习",
      terminal: "voice",
    },
  });
  const body = practiced as {
    result: { structuredContent: { say: string } };
  };
  assertEquals(body.result.structuredContent.say.includes("先说角色名"), true);
  assertEquals(peerScans, 0);
});

Deno.test("RestHub open room does not overwrite another device row", async () => {
  const rest = memoryRest();
  const otherEngine = new GameEngine();
  await otherEngine.handle({
    deviceId: "别人",
    commandId: "p1",
    tool: "submit_lobby_text",
    text: "练习",
    terminal: "voice",
  });
  const otherBefore = otherEngine.exportState();
  await rest.request(
    "http://rest.local/rest/v1/ly_device_engine?on_conflict=device_key",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{
        device_key: "别人",
        state: otherBefore,
        updated_at: new Date().toISOString(),
      }]),
    },
  );

  const hub = new RestHub(rest, () => true, () => true);
  await hub.call({
    sessionId: "s-host",
    rpcId: 1,
    command: {
      deviceId: "房主",
      commandId: "open",
      tool: "submit_lobby_text",
      text: "开房间",
      terminal: "voice",
    },
  });

  const otherRow = rest.tables.get("ly_device_engine")?.find((row) =>
    row.device_key === "别人"
  );
  assertEquals(JSON.stringify(otherRow?.state), JSON.stringify(otherBefore));
});

Deno.test("RestHub guest join pushes to a parked host wait_event", async () => {
  const rest = memoryRest();
  const inbox: unknown[] = [];
  const hub = new RestHub(rest, () => true, (_sessionId, body) => {
    inbox.push(body);
    return true;
  });
  const opened = await hub.call({
    sessionId: "s-host",
    rpcId: 1,
    command: {
      deviceId: "小易",
      commandId: "open",
      tool: "submit_lobby_text",
      text: "开房间",
      terminal: "voice",
    },
  });
  const openBody = opened as {
    result: { structuredContent: { say: string } };
  };
  const digits = openBody.result.structuredContent.say.match(/\d/g)?.join("") ??
    "";
  assertEquals(digits.length, 4);

  const parked = await hub.call({
    sessionId: "s-host",
    rpcId: 2,
    command: {
      deviceId: "小易",
      commandId: "wait1",
      tool: "wait_event",
      terminal: "voice",
    },
  });
  assertEquals(parked, null);
  assertEquals(
    (rest.tables.get("ly_mcp_sub") ?? []).some((row) =>
      row.device_key === "小易"
    ),
    true,
  );

  const joined = await hub.call({
    sessionId: "s-guest",
    rpcId: 3,
    command: {
      deviceId: "小贾",
      commandId: "join",
      tool: "submit_lobby_text",
      text: `加入房间${digits}。`,
      terminal: "voice",
    },
  });
  const joinBody = joined as {
    result: { structuredContent: { say: string } };
  };
  assertEquals(joinBody.result.structuredContent.say.includes("已加入"), true);

  const pushed = inbox
    .map((item) => {
      const row = item as {
        result?: { structuredContent?: { say?: string } };
      };
      return row.result?.structuredContent?.say ?? "";
    })
    .find((say) => say.includes("对手来了"));
  assertEquals(Boolean(pushed), true);
});

Deno.test("RestHub wait_event returns pending join notice instead of a blank hold", async () => {
  const rest = memoryRest();
  const inbox: unknown[] = [];
  const hub = new RestHub(rest, () => true, (_sessionId, body) => {
    inbox.push(body);
    return true;
  });
  await rest.request(
    "http://rest.local/rest/v1/ly_mcp_pending",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{
        device_key: "小易",
        body: {
          code: "ACCEPTED",
          event_id: "e1",
          say: "对手来了。请选角色并准备。",
          clips: [],
          stop_clips: false,
          ack_required: false,
          phase: "LOBBY",
          wait: true,
        },
      }, {
        device_key: "小易",
        body: {
          code: "ACCEPTED",
          event_id: "e2",
          say: "对手选了烈焰剑士。",
          clips: [],
          stop_clips: false,
          ack_required: false,
          phase: "LOBBY",
          wait: true,
        },
      }]),
    },
  );

  const waited = await hub.call({
    sessionId: "s-host",
    rpcId: 9,
    command: {
      deviceId: "小易",
      commandId: "w1",
      tool: "wait_event",
      terminal: "voice",
    },
  });
  const body = waited as {
    result: { structuredContent: { say: string; wait: boolean } };
  };
  assertEquals(
    body.result.structuredContent.say,
    "对手来了。请选角色并准备。对手选了烈焰剑士。",
  );
  assertEquals(body.result.structuredContent.wait, true);
  assertEquals(rest.tables.get("ly_mcp_pending")?.length ?? 0, 0);
  assertEquals(inbox.length >= 1, true);
});

Deno.test("RestHub without peer merge would miss the room", async () => {
  // 回归：只读本机行时，加入方看不到房主开的房。
  const rest = memoryRest();
  const hostEngine = new GameEngine({ random: () => 0.9518 });
  await hostEngine.handle({
    deviceId: "房主",
    commandId: "open",
    tool: "submit_lobby_text",
    text: "开房间",
    terminal: "voice",
  });
  await rest.request(
    "http://rest.local/rest/v1/ly_device_engine?on_conflict=device_key",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{
        device_key: "房主",
        state: hostEngine.exportState(),
        updated_at: new Date().toISOString(),
      }]),
    },
  );

  const alone = new GameEngine();
  const guestOnly = await alone.handle({
    deviceId: "小贾",
    commandId: "join",
    tool: "submit_lobby_text",
    text: "加入房间9518。",
    terminal: "voice",
  });
  assertEquals(guestOnly.caller?.say, "没有这个房间。");
});
