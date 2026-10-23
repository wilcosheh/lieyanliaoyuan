import { assertEquals } from "@std/assert";
import { extractChantAudio, signedUrlOf } from "./audio.ts";

Deno.test("从聊天记录里找到这句咒语的原始录音", () => {
  const url = extractChantAudio({
    data: [
      { chatType: 2, content: "开战", audioUrl: null },
      { chatType: 1, content: "火矢", audioUrl: "https://cdn.example/a.wav" },
      { chatType: 1, content: "水幕", audioUrl: "https://cdn.example/b.wav" },
    ],
  }, "火矢");
  assertEquals(url, "https://cdn.example/a.wav");
  assertEquals(
    signedUrlOf(
      { data: { signed_url: "https://cdn.example/signed.wav" } },
      "raw",
    ),
    "https://cdn.example/signed.wav",
  );
});
