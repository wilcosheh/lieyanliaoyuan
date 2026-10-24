import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WEB_CHARACTERS } from "@core/web/characters.ts";
import { WebApplicationError } from "@core/web/battle_application.ts";
import { narrateEvent } from "@core/web/narration.ts";
import { runtime as serverRuntime } from "@web/server/runtime";
import {
  createSessionToken,
  readPlayerId,
  SESSION_COOKIE,
} from "@web/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path: string[] }> };

const nicknameSchema = z.object({ nickname: z.string().trim().min(1).max(20) });
const characterSchema = z.object({ characterId: z.string().min(1).max(40) });
const readySchema = z.object({ ready: z.boolean().default(true) });
const recognizedActionSchema = z.object({
  commandId: z.string().uuid(),
  roundNo: z.number().int().positive(),
  transcript: z.string().trim().min(1).max(100),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function playerId(): Promise<string> {
  const id = readPlayerId(await cookies());
  if (!id) throw new WebApplicationError("UNAUTHENTICATED", undefined, 401);
  return id;
}

async function body<T>(request: NextRequest, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await request.json());
}

function handleError(error: unknown): NextResponse {
  // 共享源码可能被 Next 以不同模块路径打包，不能只依赖 instanceof 判断。
  if (
    error instanceof WebApplicationError ||
    (typeof error === "object" && error !== null &&
      "code" in error && typeof error.code === "string" &&
      "status" in error && typeof error.status === "number")
  ) {
    const applicationError = error as WebApplicationError;
    return json(
      {
        error: {
          code: applicationError.code,
          message: applicationError.message,
          details: applicationError.details,
        },
      },
      applicationError.status,
    );
  }
  if (error instanceof z.ZodError) {
    return json(
      { error: { code: "INVALID_REQUEST", issues: error.issues } },
      400,
    );
  }
  console.error(error);
  return json({ error: { code: "INTERNAL_ERROR" } }, 500);
}

export async function GET(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  try {
    const path = (await context.params).path;
    if (path.length === 1 && path[0] === "characters") {
      return json({ characters: WEB_CHARACTERS });
    }
    const id = await playerId();
    if (path[0] === "matchmaking" && path[1] === "tickets" && path[2]) {
      return json({
        ticket: await serverRuntime.application.getMatch(path[2], id),
      });
    }
    if (path[0] === "battles" && path[1] && path.length === 2) {
      const after = Number(
        request.nextUrl.searchParams.get("afterSequence") ?? 0,
      );
      return json({
        battle: await serverRuntime.application.getBattle(
          path[1],
          id,
          Number.isSafeInteger(after) ? after : 0,
        ),
      });
    }
    if (
      path[0] === "battles" && path[1] && path[2] === "events" && path[3] &&
      path[4] === "audio"
    ) {
      const view = await serverRuntime.application.getBattle(path[1], id);
      const sequence = Number(path[3]);
      const event = view.events.find((item) => item.sequence === sequence);
      if (!event) {
        throw new WebApplicationError("EVENT_NOT_FOUND", undefined, 404);
      }
      const battle = await serverRuntime.battles.getBattle(path[1]);
      if (!battle.ok) {
        throw new WebApplicationError(battle.error.code, undefined, 404);
      }
      const spoken = await serverRuntime.speech.synthesize({
        text: narrateEvent(event, battle.state),
      });
      return new NextResponse(spoken.audio as BodyInit, {
        headers: {
          "Content-Type": spoken.contentType,
          "Cache-Control": "private, max-age=86400",
        },
      });
    }
    return json({ error: { code: "NOT_FOUND" } }, 404);
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  try {
    const path = (await context.params).path;
    if (path.length === 1 && path[0] === "sessions") {
      const current = readPlayerId(await cookies());
      const session = current
        ? { playerId: current, token: null }
        : createSessionToken();
      const response = json(
        { session: { playerId: session.playerId } },
        current ? 200 : 201,
      );
      if (session.token) {
        response.cookies.set(SESSION_COOKIE, session.token, {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          maxAge: 60 * 60 * 24 * 30,
          path: "/",
        });
      }
      return response;
    }
    const id = await playerId();
    if (
      path[0] === "matchmaking" && path[1] === "tickets" && path.length === 2
    ) {
      const input = await body(request, nicknameSchema);
      return json({
        ticket: await serverRuntime.application.joinMatch(id, input.nickname),
      }, 201);
    }
    if (path[0] === "battles" && path[1] && path[2] === "character") {
      const input = await body(request, characterSchema);
      return json({
        battle: await serverRuntime.application.selectCharacter(
          path[1],
          id,
          input.characterId,
        ),
      });
    }
    if (path[0] === "battles" && path[1] && path[2] === "ready") {
      const input = await body(request, readySchema);
      return json({
        battle: await serverRuntime.application.setReady(
          path[1],
          id,
          input.ready,
        ),
      });
    }
    if (
      path[0] === "battles" && path[1] && path[2] === "actions" &&
      path[3] === "voice"
    ) {
      const form = await request.formData();
      const commandId = z.string().uuid().parse(form.get("commandId"));
      const roundNo = z.coerce.number().int().positive().parse(
        form.get("roundNo"),
      );
      const audio = form.get("audio");
      if (
        !(audio instanceof File) || audio.size === 0 ||
        audio.size > 5 * 1024 * 1024
      ) {
        throw new WebApplicationError("INVALID_AUDIO", undefined, 400);
      }
      const result = await serverRuntime.application.submitVoiceAction({
        battleId: path[1],
        playerId: id,
        commandId,
        roundNo,
        audio: new Uint8Array(await audio.arrayBuffer()),
        contentType: audio.type || "audio/wav",
      });
      return json({ action: result });
    }
    if (
      path[0] === "battles" && path[1] && path[2] === "actions" &&
      path[3] === "recognized"
    ) {
      const input = await body(request, recognizedActionSchema);
      const result = await serverRuntime.application.submitRecognizedAction({
        battleId: path[1],
        playerId: id,
        ...input,
      });
      return json({ action: result });
    }
    return json({ error: { code: "NOT_FOUND" } }, 404);
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  try {
    const path = (await context.params).path;
    const id = await playerId();
    if (path[0] === "matchmaking" && path[1] === "tickets" && path[2]) {
      await serverRuntime.application.cancelMatch(path[2], id);
      return new NextResponse(null, { status: 204 });
    }
    return json({ error: { code: "NOT_FOUND" } }, 404);
  } catch (error) {
    return handleError(error);
  }
}
