import type { ChantLookup } from "../src/adapter/mcp/audio.ts";
import { handle, type ServerCtx } from "../src/adapter/mcp/handler.ts";
import { MemoryStore } from "../src/adapter/mcp/store.ts";

type Rpc = {
  id?: number | string | null;
  result?: {
    content?: Array<{ text?: string }>;
    structuredContent?: {
      funcs?: Array<{ name: string; arguments: Record<string, string> }>;
    };
  };
  error?: { message?: string };
};

const chant: ChantLookup = (job) => {
  if (job.utterance.includes("火矢")) {
    return Promise.resolve("https://chant.example/huoshi.wav");
  }
  return Promise.resolve(null);
};

const ctx: ServerCtx = {
  store: new MemoryStore(true),
  timeScale: 10,
  lookup: chant,
  audioEnabled: true,
};

const server = Deno.serve(
  { port: 0, hostname: "127.0.0.1" },
  (req) => handle(req, ctx),
);
const port = (server.addr as Deno.NetAddr).port;
const root = `http://127.0.0.1:${port}/mcp`;

async function main() {
  let a: Client | undefined;
  let b: Client | undefined;
  try {
    a = await Client.open(root, "device-a");
    b = await Client.open(root, "device-b");
    const listed = await a.call("tools/list", {}, "tools/list");
    const names = JSON.stringify(listed);
    must(
      names.includes("wait_event") && names.includes("cast"),
      "tools/list 缺少对战工具",
    );

    const room = await a.call("create_room");
    const code = text(room).match(/\d{4}/)?.[0];
    must(!!code, `没有房间号: ${text(room)}`);
    await b.call("set_name", { name: "乙" });
    const joined = await b.call("join_room", { code });
    must(text(joined).includes("已加入"), text(joined));

    const readyA = a.call("ready");
    const readyB = b.call("ready");
    const [openA, openB] = await Promise.all([readyA, readyB]);
    must(text(openA).includes("开战"), text(openA));
    must(text(openB).includes("开战"), text(openB));
    must(text(openA).includes("三"), text(openA));
    must(
      !funcs(openA).some((fn) => fn.name === "change_role"),
      "开战播报不该和切角色绑在同一次返回",
    );
    must(text(openA).includes("30血"), text(openA));

    const heard = b.call("wait_event");
    await sleep(30);
    const shot = await a.call("cast", { utterance: "火矢" });
    const news = await heard;
    must(text(shot).includes("火矢命中"), text(shot));
    must(text(news).includes("中了火矢"), text(news));
    must(
      urls(news).every((url) => !url.includes("/sfx/")),
      `战报不该套播放 ${text(news)}`,
    );
    must(
      !urls(news).some((url) => url.includes("chant.example")),
      "原声不应堵在命中这一拍",
    );

    const voice = await b.call("wait_event");
    must(text(voice).includes("对方原声"), text(voice));
    must(
      urls(voice).includes("https://chant.example/huoshi.wav"),
      JSON.stringify(urls(voice)),
    );

    await sleep(400);
    const casting = a.call("wait_event");
    await sleep(20);
    const chanted = await b.call("cast", { utterance: "烈焰燎原" });
    const heardChant = await casting;
    must(text(chanted).includes("吟唱烈焰燎原"), text(chanted));
    must(text(heardChant).includes("对手开始吟唱烈焰燎原"), text(heardChant));

    await sleep(120);
    const broken = b.call("wait_event");
    const interrupt = await a.call("cast", { utterance: "火矢" });
    const victim = await broken;
    must(text(interrupt).includes("火矢命中"), text(interrupt));
    must(text(victim).includes("吟唱被打断"), text(victim));
    must(
      urls(victim).every((url) => !url.includes("/sfx/")),
      "打断不该套播放",
    );

    const winWait = a.call("wait_event");
    const surrendered = await b.call("surrender");
    const won = await winWait;
    must(text(surrendered).includes("你认输了"), text(surrendered));
    must(text(won).includes("你赢了"), text(won));
    must(urls(won).every((url) => !url.includes("/sfx/")), "胜利不该套播放");
    must(
      urls(surrendered).every((url) => !url.includes("/sfx/")),
      "认输不该套播放",
    );
    const reviewRole = await a.call("wait_event");
    must(
      funcs(reviewRole).some((fn) => fn.name === "change_role"),
      "结算没有切回复盘",
    );

    const wav = await fetch(`${root}/sfx/huoshi.wav`);
    const bytes = new Uint8Array(await wav.arrayBuffer());
    must(
      wav.ok && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
        bytes[3] === 0x46,
      "音效不是 wav",
    );

    const review = await a.call("review_last_match");
    must(text(review).includes("你赢了"), text(review));
    console.log("sim ok", {
      code,
      shot: text(shot),
      news: text(news),
      voice: text(voice),
      won: text(won),
    });
  } finally {
    await a?.close();
    await b?.close();
    await server.shutdown();
  }
}

class Client {
  private buf = "";
  private endpoint = "";
  private nextId = 1;
  private pending = new Map<string, (msg: Rpc) => void>();
  private endpointReady: Promise<void>;
  private markReady = () => {};

  close(): Promise<void> {
    return this.reader.cancel();
  }

  private constructor(
    private deviceId: string,
    private reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {
    this.endpointReady = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  static async open(root: string, deviceId: string): Promise<Client> {
    const res = await fetch(root, {
      headers: { accept: "text/event-stream", "x-linx-device-id": deviceId },
    });
    if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
    const client = new Client(deviceId, res.body.getReader());
    client.pump();
    await client.endpointReady;
    const init = await client.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sim", version: "0" },
    });
    if (!JSON.stringify(init).includes("lieyanliaoyuan")) {
      throw new Error("initialize failed");
    }
    return client;
  }

  call(
    name: string,
    args: Record<string, unknown> = {},
    method = "tools/call",
  ): Promise<Rpc> {
    const params = method === "tools/call" ? { name, arguments: args } : args;
    return this.rpc(method, params);
  }

  private rpc(method: string, params: unknown): Promise<Rpc> {
    const id = this.nextId++;
    const body = { jsonrpc: "2.0", id, method, params };
    const wait = new Promise<Rpc>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout ${method} #${id}`)),
        5000,
      );
      this.pending.set(String(id), (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
    fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linx-device-id": this.deviceId,
        "x-linx-agent-id": "agent-demo",
        "x-linx-session-id": `sess-${this.deviceId}`,
      },
      body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok && res.status !== 202) throw new Error(`post ${res.status}`);
    }).catch((error) => {
      const resolve = this.pending.get(String(id));
      if (!resolve) throw error;
    });
    return wait;
  }

  private async pump() {
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await this.reader.read();
      if (done) break;
      this.buf += decoder.decode(value);
      while (true) {
        const idx = this.buf.indexOf("\n\n");
        if (idx < 0) break;
        const raw = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        this.onEvent(raw.replaceAll("\r\n", "\n"));
      }
    }
  }

  private onEvent(raw: string) {
    let event = "message";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    const payload = data.join("\n");
    if (!payload) return;
    if (event === "endpoint") {
      this.endpoint = payload;
      this.markReady();
      return;
    }
    const msg = JSON.parse(payload) as Rpc;
    if (msg.id === undefined || msg.id === null) return;
    const resolve = this.pending.get(String(msg.id));
    if (!resolve) return;
    this.pending.delete(String(msg.id));
    resolve(msg);
  }
}

function text(msg: Rpc): string {
  return msg.result?.content?.[0]?.text ?? msg.error?.message ?? "";
}

function funcs(msg: Rpc) {
  return msg.result?.structuredContent?.funcs ?? [];
}

function urls(msg: Rpc): string[] {
  return funcs(msg).map((fn) => fn.arguments.audio_url).filter((
    url,
  ): url is string => !!url);
}

function must(ok: boolean, detail: string) {
  if (!ok) throw new Error(detail);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
