import { assertEquals } from "@std/assert";
import { audienceFor } from "./delivery.ts";

Deno.test("the caller's own event returns on the command", () => {
  assertEquals(
    audienceFor({ speakerIsCaller: true, eventFromCaller: true }),
    "caller",
  );
});

Deno.test("the opponent's event waits on their subscription", () => {
  assertEquals(
    audienceFor({ speakerIsCaller: false, eventFromCaller: true }),
    "subscription",
  );
});
