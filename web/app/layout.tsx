import type { Metadata } from "next";
import { QueryProvider } from "@web/providers/query-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "烈焰燎原",
  description: "以声音抢占回合的双人咒术对战",
};

export default function RootLayout(
  { children }: Readonly<{ children: React.ReactNode }>,
) {
  return (
    <html lang="zh-CN">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
