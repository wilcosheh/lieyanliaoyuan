import { assertEquals } from "@std/assert";
import { due } from "./clock.ts";

Deno.test("clock reports only the deadlines that have passed", () => {
  assertEquals(
    due({
      opensAt: 1_000,
      ackDeadline: 2_000,
      disconnectDeadline: 5_000,
      cpuCompleteAt: 3_000,
    }, 2_500),
    ["open", "ack"],
  );
});
