import { CHARACTERS } from "../../engine/characters/skills.ts";
import { GameEngine, type ToolName } from "../../engine/service/game.ts";
import { MemoryHub } from "./hub.ts";
import { PostgresHub } from "./postgres.ts";
import { RestHub } from "./rest_hub.ts";
import {
  INSTRUCTIONS,
  messageEndpoint,
  type RpcId,
  rpcResult,
  toolArguments,
} from "./protocol.ts";

type Session = {
  id: string;
  send: (event: string, data: string) => void;
};

type Hub = MemoryHub | PostgresHub | RestHub;

function createHub(
  options: {
    engine?: GameEngine;
    databaseUrl?: string;
    supabaseUrl?: string;
    serviceRoleKey?: string;
  },
  owns: (sessionId: string) => boolean,
  send: (sessionId: string, body: unknown) => boolean,
): Hub {
  const supabaseUrl = options.supabaseUrl?.replace(/\/$/, "");
  const serviceRoleKey = options.serviceRoleKey;
  if (supabaseUrl && serviceRoleKey) {
    return new RestHub(
      { url: supabaseUrl, key: serviceRoleKey, request: fetch },
      owns,
      send,
    );
  }
  if (options.databaseUrl) {
    return new PostgresHub(options.databaseUrl, owns, send);
  }
  return new MemoryHub(options.engine ?? new GameEngine(), send);
}

const TOOLS: Array<{ name: ToolName; description: string }> = [
  {
    name: "submit_lobby_text",
    description:
      "大厅或复盘里的原话。选角、练习、对电脑、人机对战、开房间、创建房间、房间号、准备、再来一局、复盘。device_id 用提示词里的设备号，不要填烈焰燎原或角色名。text 填玩家原话。",
  },
  {
    name: "submit_utterance",
    description:
      "练习或战场里的整句转写。练习里先认结束练习，战场里先认看血、还有哪些技能、投降，其余当作念完的技能。text 填原话，完成度可省略。",
  },
  {
    name: "begin_cast",
    description:
      "开口时调用。窗口没开则被拒绝。同机要把声纹分出的 seat 一并传入。",
  },
  { name: "cancel_cast", description: "取消自己还没念完的施法。" },
  {
    name: "ack_playback",
    description:
      "战况或开场已经念完。只传 device_id，不要传 text。念完若 wait 为 true，再调用 wait_event。倒数不需要回执。",
  },
  {
    name: "wait_event",
    description:
      "仅当上一条工具返回 wait 为 true 时调用。有下一条主持句时，用同一个调用从 SSE 返回。不要用它回答玩家刚说的话。",
  },
];

function cors(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "authorization, content-type, accept, apikey, mcp-session-id, key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-expose-headers": "mcp-session-id",
  };
}

export function createMcpServer(options: {
  engine?: GameEngine;
  connectionKey: string;
  voiceprint?: boolean;
  databaseUrl?: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
}): (req: Request) => Promise<Response> {
  const sessions = new Map<string, Session>();
  const send = (sessionId: string, body: unknown): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.send("message", JSON.stringify(body));
    return true;
  };
  const hub = createHub(
    options,
    (id) => sessions.has(id),
    send,
  );

  const authorized = (req: Request): boolean => {
    if (!options.connectionKey) return false;
    const url = new URL(req.url);
    if (url.searchParams.get("key") === options.connectionKey) return true;
    if (req.headers.get("key") === options.connectionKey) return true;
    const header = req.headers.get("authorization") ?? "";
    if (header === `Bearer ${options.connectionKey}`) return true;
    return false;
  };

  return async (req) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }
    if (!authorized(req)) {
      return new Response("unauthorized", { status: 401, headers: cors() });
    }
    const url = new URL(req.url);
    const kind = classify(url.pathname);
    if (kind === "health") {
      return Response.json({ ok: true }, { headers: cors() });
    }
    if (kind === "sse" && req.method === "GET") {
      return openSse(req, sessions, hub);
    }
    if (kind === "sse" && req.method === "POST") {
      try {
        return await streamable(
          req,
          sessions,
          hub,
          options.voiceprint === true,
        );
      } catch (error) {
        console.error("mcp streamable", error);
        return new Response("internal error", {
          status: 500,
          headers: cors(),
        });
      }
    }
    if (kind === "message" && req.method === "POST") {
      try {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        let payload: {
          id?: RpcId;
          method?: string;
          params?: Record<string, unknown>;
        } = {};
        try {
          payload = await req.json();
        } catch {
          payload = {};
        }
        const handled = await acceptMessage(payload, {
          hub,
          voiceprint: options.voiceprint === true,
          sessionId,
        });
        return handled.response;
      } catch (error) {
        console.error("mcp message", error);
        return new Response("internal error", {
          status: 500,
          headers: cors(),
        });
      }
    }
    return new Response("not found", { status: 404, headers: cors() });
  };
}

function classify(pathname: string): "sse" | "message" | "health" | "unknown" {
  if (pathname === "/health" || pathname.endsWith("/health")) return "health";
  const idx = pathname.indexOf("/mcp");
  if (idx < 0) return "unknown";
  const rest = pathname.slice(idx + 4);
  if (rest === "" || rest === "/") return "sse";
  if (rest === "/message") return "message";
  return "unknown";
}

function openSse(
  req: Request,
  sessions: Map<string, Session>,
  hub: Hub,
): Response {
  const id = crypto.randomUUID();
  let send: Session["send"] = () => {};
  let beat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      send = (event, data) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
        );
      };
      sessions.set(id, { id, send });
      hub.watch(id);
      send("endpoint", messageEndpoint(req, id));
      beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
          if ("tick" in hub && typeof hub.tick === "function") {
            hub.tick(id);
          }
        } catch {
          if (beat !== undefined) clearInterval(beat);
        }
      }, 10_000);
    },
    cancel() {
      if (beat !== undefined) clearInterval(beat);
      hub.unwatch(id);
      sessions.delete(id);
    },
  });
  req.signal.addEventListener("abort", () => {
    if (beat !== undefined) clearInterval(beat);
    hub.unwatch(id);
    sessions.delete(id);
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

async function streamable(
  req: Request,
  sessions: Map<string, Session>,
  hub: Hub,
  voiceprint: boolean,
): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id")?.trim() ||
    crypto.randomUUID();
  let latest: unknown = null;
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      send: (_event, data) => {
        try {
          latest = JSON.parse(data);
        } catch {
          latest = data;
        }
      },
    });
    hub.watch(sessionId);
  } else {
    const previous = sessions.get(sessionId)!;
    sessions.set(sessionId, {
      id: sessionId,
      send: (event, data) => {
        previous.send(event, data);
        try {
          latest = JSON.parse(data);
        } catch {
          latest = data;
        }
      },
    });
  }

  const raw = await req.text();
  let payload: {
    id?: RpcId;
    method?: string;
    params?: Record<string, unknown>;
  } = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const method = String(payload.method ?? "");
  const expect = payload.id !== undefined &&
    !method.startsWith("notifications/");

  const handled = await acceptMessage(payload, { hub, voiceprint, sessionId });
  if (!expect) return handled.response;

  const isWait = method === "tools/call" &&
    String((payload.params as { name?: string } | undefined)?.name) ===
      "wait_event";
  let body = handled.body ?? latest;
  if (body === null && isWait) {
    const deadline = Date.now() + 120_000;
    while (body === null && Date.now() < deadline && !req.signal.aborted) {
      if ("tick" in hub && typeof hub.tick === "function") hub.tick(sessionId);
      await sleep(50);
      body = latest;
    }
  }

  if (body === null) {
    // 非 wait_event 若仍无 body，勿回 202 空壳——灵矽会显示空 result 并自行编词。
    if (!isWait && payload.id !== undefined) {
      body = {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [{ type: "text", text: "刚才没听清，请再说一次。" }],
          structuredContent: {
            code: "ACCEPTED",
            phase: "LOBBY",
            say: "刚才没听清，请再说一次。",
            wait: false,
            ack_required: false,
            event_id: "",
            clips: [],
            stop_clips: false,
            funcs: [],
          },
        },
      };
    } else {
      return handled.response;
    }
  }

  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) {
    return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
      status: 200,
      headers: {
        ...cors(),
        ...sessionHeader(sessionId),
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    });
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...cors(),
      ...sessionHeader(sessionId),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function acceptMessage(
  payload: {
    id?: RpcId;
    method?: string;
    params?: Record<string, unknown>;
  },
  ctx: { hub: Hub; voiceprint: boolean; sessionId: string },
): Promise<{ response: Response; body: unknown | null }> {
  const id = payload.id;
  const method = String(payload.method ?? "");
  const params = toolArguments(payload.params);
  const sessionId = ctx.sessionId;
  const done = (body: unknown | null = null) => ({
    response: accepted(sessionId),
    body,
  });
  if (method === "notifications/cancelled") {
    const requestId = params.requestId ?? params.request_id;
    if (typeof requestId === "number" || typeof requestId === "string") {
      await ctx.hub.cancel(sessionId, requestId);
    }
    return done();
  }
  if (id === undefined || method.startsWith("notifications/")) {
    return done();
  }
  if (method === "initialize") {
    const version = typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : "2024-11-05";
    const body = {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "lieyanliaoyuan", version: "1" },
        instructions: INSTRUCTIONS,
      },
    };
    await ctx.hub.publish(sessionId, body);
    return done(body);
  }
  if (method === "ping") {
    const body = { jsonrpc: "2.0", id, result: {} };
    await ctx.hub.publish(sessionId, body);
    return done(body);
  }
  if (method === "tools/list") {
    const body = {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: "object",
            properties: {
              device_id: { type: "string" },
              seat: { type: "string", enum: ["A", "B"] },
              text: { type: "string" },
              perfection: { type: "number", minimum: 0, maximum: 100 },
            },
            required: ["device_id"],
            additionalProperties: false,
          },
        })),
      },
    };
    await ctx.hub.publish(sessionId, body);
    return done(body);
  }
  if (method !== "tools/call") {
    const body = {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "method not found" },
    };
    await ctx.hub.publish(sessionId, body);
    return done(body);
  }
  const name = String(params.name ?? "") as ToolName;
  const args = toolArguments(params.arguments ?? params.args);
  if (!args.device_id || !TOOLS.some((tool) => tool.name === name)) {
    const body = {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "invalid params" },
    };
    await ctx.hub.publish(sessionId, body);
    return done(body);
  }
  const seat = args.seat === "A" || args.seat === "B" ? args.seat : undefined;
  const deviceId = String(args.device_id);
  if (
    deviceId === "烈焰燎原" || CHARACTERS.some((item) => item.name === deviceId)
  ) {
    const body = rpcResult(id, {
      code: "INVALID_DEVICE",
      event_id: "",
      say: "设备号无效。请改用提示词里的设备号。",
      clips: [],
      stop_clips: false,
      ack_required: false,
      phase: "LOBBY",
      wait: false,
    });
    await ctx.hub.publish(sessionId, body);
    return done(body);
  }
  const perfection = typeof args.perfection === "number"
    ? args.perfection
    : undefined;
  const body = await ctx.hub.call({
    sessionId,
    rpcId: id,
    command: {
      deviceId,
      commandId: `${deviceId}:${sessionId}:${String(id)}`,
      tool: name,
      text: typeof args.text === "string" ? args.text : undefined,
      perfection,
      seat,
      voiceprint: ctx.voiceprint,
      terminal: "voice",
    },
  });
  return done(body);
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

function sessionHeader(session?: string): Record<string, string> {
  return session ? { "mcp-session-id": session } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const databaseUrl = Deno.env.get("DATABASE_URL") ||
  Deno.env.get("SUPABASE_DB_URL") ||
  "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const shared = Boolean(supabaseUrl && serviceRoleKey) || Boolean(databaseUrl);

export const handle = createMcpServer({
  engine: shared ? undefined : new GameEngine(),
  connectionKey: Deno.env.get("MCP_CONNECTION_KEY") ?? "",
  voiceprint: Deno.env.get("MCP_VOICEPRINT") === "1",
  databaseUrl: databaseUrl || undefined,
  supabaseUrl: supabaseUrl || undefined,
  serviceRoleKey: serviceRoleKey || undefined,
});
