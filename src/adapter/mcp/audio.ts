export type HistoryRow = Record<string, unknown>;

export type ChantLookup = (job: {
  deviceId: string;
  utterance: string;
  agentId: string;
  sessionId: string;
}) => Promise<string | null>;

export function extractChantAudio(
  payload: unknown,
  utterance: string,
): string | null {
  const rows = unwrapRows(payload);
  const want = utterance.replace(/\s+/g, "");
  if (!want) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (!isUser(row)) continue;
    const text = textOf(row).replace(/\s+/g, "");
    if (!text.includes(want.slice(0, Math.min(8, want.length)))) continue;
    const audio = audioOf(row);
    if (audio) return audio;
  }
  return null;
}

export function signedUrlOf(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const body = payload as Record<string, unknown>;
  const data = body.data && typeof body.data === "object"
    ? body.data as Record<string, unknown>
    : {};
  const found = body.signed_url ?? body.signedUrl ?? data.signed_url ??
    data.signedUrl;
  return typeof found === "string" && found.length > 0 ? found : fallback;
}

export function linxLookup(): ChantLookup {
  const key = Deno.env.get("LINX_API_KEY") ?? "";
  const base = (Deno.env.get("LINX_API_BASE") ?? "https://xrobo.qiniu.com")
    .replace(/\/$/, "");
  return async (job) => {
    if (!key || !job.agentId || !job.sessionId) return null;
    const historyUrl = `${base}/xiaozhi/agent/${
      encodeURIComponent(job.agentId)
    }/chat-history/${encodeURIComponent(job.sessionId)}`;
    const history = await fetch(historyUrl, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!history.ok) return null;
    const raw = extractChantAudio(await history.json(), job.utterance);
    if (!raw) return null;
    const signed = await fetch(`${base}/v1/objects/signed-url`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: raw }),
      signal: AbortSignal.timeout(3000),
    });
    if (!signed.ok) return raw;
    return signedUrlOf(await signed.json(), raw);
  };
}

function unwrapRows(payload: unknown): HistoryRow[] {
  if (Array.isArray(payload)) return payload.filter(isRow);
  if (!payload || typeof payload !== "object") return [];
  const body = payload as Record<string, unknown>;
  for (const key of ["data", "list", "records", "rows"]) {
    const value = body[key];
    if (Array.isArray(value)) return value.filter(isRow);
    if (value && typeof value === "object") {
      const nested = unwrapRows(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function isRow(value: unknown): value is HistoryRow {
  return !!value && typeof value === "object";
}

function isUser(row: HistoryRow): boolean {
  const kind = row.chatType ?? row.chat_type ?? row.role ?? row.type;
  return kind === 1 || kind === "1" || kind === "user";
}

function textOf(row: HistoryRow): string {
  const value = row.content ?? row.text ?? row.utterance ?? "";
  return typeof value === "string" ? value : "";
}

function audioOf(row: HistoryRow): string | null {
  const value = row.audioUrl ?? row.audio_url ?? row.audioURL ?? "";
  return typeof value === "string" && value.startsWith("http") ? value : null;
}
