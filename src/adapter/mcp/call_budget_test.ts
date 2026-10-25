import { assertEquals } from "@std/assert";
import { settleHubCall } from "./call_budget.ts";

Deno.test("a call that finishes just after the budget still returns the engine line", async () => {
  const body = await settleHubCall(
    new Promise((resolve) => setTimeout(() => resolve("已选烈焰剑士。"), 40)),
    10,
    () => Promise.resolve("刚才没听清，请再说一次。"),
  );
  assertEquals(body, "已选烈焰剑士。");
});

Deno.test("a failed call falls back only when the engine never produced a line", async () => {
  const body = await settleHubCall(
    Promise.reject(new Error("db")),
    1_000,
    () => Promise.resolve("刚才没听清，请再说一次。"),
  );
  assertEquals(body, "刚才没听清，请再说一次。");
});
