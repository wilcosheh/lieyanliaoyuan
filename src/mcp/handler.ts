import {
  BATTLE_PROMPT,
  LOBBY_PROMPT,
  PRACTICE_PROMPT,
  REVIEW_PROMPT,
  type RpcId,
} from "../game/logic.ts";
import { type ChantLookup, linxLookup } from "./audio.ts";
import { isSfxName, synthWav } from "./sfx.ts";
import { MemoryStore, type Store } from "./store.ts";
import { SupabaseStore } from "./supabase_store.ts";

export type ServerCtx = {
  store: Store;
  timeScale: number;
  lookup: ChantLookup;
  audioEnabled: boolean;
};

const TOOLS = [
  tool("set_name", "记下玩家名字。玩家自报姓名时调用。", {
    name: { type: "string" },
  }, ["name"]),
  tool(
    "start_practice",
    "进入咒语练习。玩家说练习、学咒、练咒语或开始练习时调用。返回后玩家每念一句就调用 practice，不要调用 cast。",
    {},
    [],
  ),
  tool(
    "practice",
    "练习念咒。utterance 必须是玩家原话。返回完美、普通或没成，以及对应效果层次，必须原样说出来。",
    { utterance: { type: "string" } },
    ["utterance"],
  ),
  tool(
    "list_spells",
    "列出可练习的咒语名称、费用和完美/普通效果，必须原样说出来。",
    {},
    [],
  ),
  tool(
    "end_practice",
    "结束咒语练习。玩家说结束练习、退出练习时调用。",
    {},
    [],
  ),
  tool(
    "create_room",
    "立刻开房，不要询问房间名称。返回四位房间号后，同一个回合里立刻调用 wait_event，直到听到对手来了。不要自己改写工具文本。",
    {},
    [],
  ),
  tool(
    "join_room",
    "用四位房间号加入。房间号放在 code 或 room_id。返回后立刻调用 wait_event。",
    { code: { type: "string" }, room_id: { type: "string" } },
    ["code"],
  ),
  tool(
    "ready",
    "准备开战。双方准备好后返回开战比分，必须原样说出来，然后立刻调用 wait_event。",
    {},
    [],
  ),
  tool(
    "cast",
    "对战中施放咒语。utterance 必须是玩家刚刚说的原话，一字不改。练习模式请用 practice，不要用 cast。",
    { utterance: { type: "string" }, audio_url: { type: "string" } },
    ["utterance"],
  ),
  tool(
    "wait_event",
    "挂起直到下一则战报。对战中会返回双方血量、法力和剩余时间，必须原样说出来，然后立刻再调用。文本如果只有句号，不要出声，立刻再调用。",
    {},
    [],
  ),
  tool(
    "match_status",
    "查看双方血量、法力、领先落后和剩余时间，必须原样说出来。",
    {},
    [],
  ),
  tool("surrender", "认输并立刻结束这局。", {}, []),
  tool("review_last_match", "对局结束后复盘刚刚那一局。", {}, []),
];

const INSTRUCTIONS = [
  LOBBY_PROMPT,
  PRACTICE_PROMPT,
  BATTLE_PROMPT,
  REVIEW_PROMPT,
].join("\n");
const origin = Date.now();

export function createDefaultCtx(): ServerCtx {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const log = Deno.env.get("LY_LOG") === "1";
  const store = supabaseUrl && serviceKey
    ? new SupabaseStore(supabaseUrl, serviceKey, log)
    : new MemoryStore(log);
  const scale = Number(Deno.env.get("LY_TIME_SCALE") ?? "1");
  return {
    store,
    timeScale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    lookup: linxLookup(),
    audioEnabled: Boolean(Deno.env.get("LINX_API_KEY")),
  };
}

export function gameNow(scale: number): number {
  if (scale === 1) return Date.now();
  return origin + (Date.now() - origin) * scale;
}

export function handle(req: Request, ctx: ServerCtx): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") {
    return Promise.resolve(
      new Response(null, { status: 204, headers: cors() }),
    );
  }
  const route = classify(url.pathname);
  if (route.kind === "health") {
    return Promise.resolve(json({ ok: true, name: "lieyanliaoyuan" }));
  }
  if (route.kind === "sfx") {
    return Promise.resolve(sfxResponse(route.sfx ?? ""));
  }
  if (route.kind === "sse" && req.method === "GET") {
    return Promise.resolve(sse(req, ctx));
  }
  if (route.kind === "sse" && req.method === "POST") {
    return streamable(req, ctx);
  }
  if (route.kind === "message" && req.method === "POST") {
    return message(req, ctx);
  }
  return Promise.resolve(json({ error: "not found" }, 404));
}

function sse(req: Request, ctx: ServerCtx): Response {
  const deviceId = header(req, "x-linx-device-id");
  const sessionId = crypto.randomUUID();
  const box = deviceId ?? sessionId;
  const base = publicBase(req);
  const encoder = new TextEncoder();
  let closed = false;
  let stop = () => {
    closed = true;
  };
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: string) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      send("endpoint", `${base}/message?sessionId=${sessionId}`);
      const beat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 10_000);
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(beat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", stop);
      const pump = async () => {
        while (!closed && !req.signal.aborted) {
          const now = gameNow(ctx.timeScale);
          try {
            await ctx.store.tick(now, base, box);
            await ctx.store.audioPass(now, ctx.lookup);
            const msgs = await ctx.store.drain(box, false);
            const sent: Array<number | string> = [];
            for (const msg of msgs) {
              if (closed) break;
              send("message", JSON.stringify(msg.body));
              if (closed) break;
              if (msg.id !== null) sent.push(msg.id);
            }
            if (sent.length) await ctx.store.ack(sent);
          } catch (error) {
            console.error("sse pump", error);
          }
          if (closed || req.signal.aborted) break;
          try {
            await ctx.store.wait(150);
          } catch (error) {
            console.error("sse wait", error);
          }
        }
        stop();
      };
      pump();
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: {
      ...cors(),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

async function streamable(req: Request, ctx: ServerCtx): Promise<Response> {
  const url = new URL(req.url);
  const key = identity(req, url);
  const session = header(req, "mcp-session-id") ?? crypto.randomUUID();
  await ctx.store.hold(key);
  try {
    let payload: JsonRpc = {};
    try {
      payload = await req.clone().json();
    } catch {
      payload = {};
    }
    const id = payload.id ?? null;
    const method = String(payload.method ?? "");
    const expect = id !== null && !method.startsWith("notifications/");
    await message(req, ctx);
    if (!expect) return accepted(session);
    const body = await waitFor(ctx, req, key, id);
    if (!wantsEventStream(req)) return json(body, 200, session);
    return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
      status: 200,
      headers: {
        ...cors(),
        ...sessionHeader(session),
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    });
  } finally {
    await ctx.store.release(key);
  }
}

function wantsEventStream(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/event-stream") || accept.includes("*/*") ||
    accept === "";
}

async function waitFor(
  ctx: ServerCtx,
  req: Request,
  key: string,
  id: RpcId,
): Promise<unknown> {
  const deadline = Date.now() + 120_000;
  const base = publicBase(req);
  while (!req.signal.aborted && Date.now() < deadline) {
    const now = gameNow(ctx.timeScale);
    try {
      await ctx.store.tick(now, base, key);
      await ctx.store.audioPass(now, ctx.lookup);
    } catch (error) {
      console.error("streamable tick", error);
    }
    const msgs = await ctx.store.drain(key, true);
    const mine = msgs.find((msg) => rpcIdOf(msg.body) === id);
    for (const msg of msgs) {
      if (msg === mine) {
        if (msg.id !== null) await ctx.store.ack([msg.id]);
        continue;
      }
      if (msg.id === null) await ctx.store.deliver(key, msg.body);
    }
    if (mine) return mine.body;
    if (req.signal.aborted || Date.now() >= deadline) break;
    await ctx.store.wait(150);
  }
  return toolError(id, "还没返回，请再调用一次。");
}

async function message(req: Request, ctx: ServerCtx): Promise<Response> {
  const url = new URL(req.url);
  const deviceId = header(req, "x-linx-device-id");
  const key = identity(req, url);
  let payload: JsonRpc;
  try {
    payload = await req.json();
  } catch {
    await ctx.store.deliver(key, rpcError(null, -32700, "parse error"));
    return accepted();
  }
  if (Array.isArray(payload)) {
    await ctx.store.deliver(
      key,
      rpcError(null, -32600, "batch is not supported"),
    );
    return accepted();
  }
  const id = payload.id ?? null;
  const method = String(payload.method ?? "");
  const params = asRecord(payload.params);
  if (id === null && method.startsWith("notifications/")) {
    if (method === "notifications/cancelled" && deviceId) {
      const requestId = params.requestId ?? params.request_id;
      if (typeof requestId === "number" || typeof requestId === "string") {
        await ctx.store.cancel(deviceId, requestId);
      }
    }
    return accepted();
  }
  if (id === null) {
    await ctx.store.deliver(key, rpcError(null, -32600, "missing id"));
    return accepted();
  }
  if (method === "initialize") {
    await ctx.store.deliver(key, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "lieyanliaoyuan", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      },
    });
    return accepted();
  }
  if (method === "ping") {
    await ctx.store.deliver(key, { jsonrpc: "2.0", id, result: {} });
    return accepted();
  }
  if (method === "tools/list") {
    await ctx.store.deliver(key, {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    });
    return accepted();
  }
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    if (!deviceId && key === "global") {
      await ctx.store.deliver(key, toolError(id, "缺少设备标识"));
      return accepted();
    }
    await ctx.store.call({
      deviceId: deviceId ?? key,
      agentId: header(req, "x-linx-agent-id") ?? "",
      sessionId: header(req, "x-linx-session-id") ?? "",
      rpcId: id,
      name,
      args: asRecord(params.arguments ?? params.args),
      audioEnabled: ctx.audioEnabled,
      sfxBase: publicBase(req),
      now: gameNow(ctx.timeScale),
    });
    return accepted();
  }
  await ctx.store.deliver(
    key,
    rpcError(id, -32601, `unknown method ${method}`),
  );
  return accepted();
}

export function publicBase(req: Request): string {
  const env = Deno.env.get("PUBLIC_BASE_URL");
  if (env) return env.replace(/\/$/, "");
  const url = new URL(req.url);
  const idx = url.pathname.indexOf("/mcp");
  const path = idx >= 0 ? url.pathname.slice(0, idx + 4) : "";
  return `${url.origin}${path}`.replace(/\/$/, "");
}

export function classify(
  pathname: string,
): { kind: "sse" | "message" | "health" | "sfx" | "unknown"; sfx?: string } {
  const idx = pathname.indexOf("/mcp");
  const rest = idx >= 0 ? pathname.slice(idx + 4) : pathname;
  if (rest === "/health" || pathname === "/health") return { kind: "health" };
  if (rest === "" || rest === "/" || pathname === "/") return { kind: "sse" };
  if (rest === "/message" || pathname === "/message") {
    return { kind: "message" };
  }
  const matched = rest.match(/^\/sfx\/([a-z]+)\.wav$/);
  if (matched) return { kind: "sfx", sfx: matched[1] };
  return { kind: "unknown" };
}

function sfxResponse(name: string): Response {
  if (!isSfxName(name)) return json({ error: "unknown sfx" }, 404);
  const bytes = synthWav(name);
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    headers: {
      ...cors(),
      "content-type": "audio/wav",
      "cache-control": "public, max-age=86400",
    },
  });
}

function accepted(session?: string): Response {
  return new Response("accepted", {
    status: 202,
    headers: {
      ...cors(),
      ...sessionHeader(session),
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function json(body: unknown, status = 200, session?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(),
      ...sessionHeader(session),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function sessionHeader(session?: string): Record<string, string> {
  return session ? { "mcp-session-id": session } : {};
}

function identity(req: Request, url: URL): string {
  return header(req, "x-linx-device-id") ??
    url.searchParams.get("sessionId") ??
    header(req, "mcp-session-id") ??
    header(req, "x-linx-session-id") ??
    "global";
}

function rpcIdOf(body: unknown): RpcId | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as { id?: RpcId | null }).id;
  if (id === undefined || id === null) return null;
  return id;
}

function cors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
}

function header(req: Request, name: string): string | null {
  const value = req.headers.get(name);
  return value && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

type JsonRpc = { id?: RpcId | null; method?: string; params?: unknown };

function rpcError(id: RpcId | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolError(id: RpcId, text: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError: true },
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}
