import { createHmac, timingSafeEqual } from "node:crypto";
import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";

export const SESSION_COOKIE = "ly_web_session";

function secret(): string {
  const configured = process.env.WEB_SESSION_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("WEB_SESSION_SECRET is required in production");
  }
  return "local-development-session-secret-change-me";
}

function sign(playerId: string): string {
  return createHmac("sha256", secret()).update(playerId).digest("base64url");
}

export function createSessionToken(): { playerId: string; token: string } {
  const playerId = crypto.randomUUID();
  return { playerId, token: `${playerId}.${sign(playerId)}` };
}

export function readPlayerId(
  cookies: Pick<ReadonlyRequestCookies, "get">,
): string | null {
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const playerId = token.slice(0, separator);
  const actual = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(playerId));
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? playerId
    : null;
}
