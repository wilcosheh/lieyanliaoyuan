import { assertEquals } from "@std/assert";
import { listenDatabaseUrl, poolerDatabaseUrl } from "./postgres.ts";

Deno.test("poolerDatabaseUrl 把会话端口改成事务池", () => {
  assertEquals(
    poolerDatabaseUrl(
      "postgresql://user:pass@db.example.com:5432/postgres",
    ),
    "postgresql://user:pass@db.example.com:6543/postgres",
  );
});

Deno.test("poolerDatabaseUrl 已是池端口时保持不变", () => {
  const url = "postgresql://user:pass@db.example.com:6543/postgres";
  assertEquals(poolerDatabaseUrl(url), url);
});

Deno.test("listenDatabaseUrl 把事务池改成会话端口", () => {
  assertEquals(
    listenDatabaseUrl(
      "postgresql://user:pass@db.example.com:6543/postgres",
    ),
    "postgresql://user:pass@db.example.com:5432/postgres",
  );
});
