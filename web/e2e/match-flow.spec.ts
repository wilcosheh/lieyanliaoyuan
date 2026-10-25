import { expect, test } from "@playwright/test";

test("两个独立浏览器完成匹配、准备和浏览器语音出招", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const installSpeechRecognition = (context: typeof firstContext) =>
    context.addInitScript(() => {
      class FakeSpeechRecognition {
        lang = "";
        continuous = false;
        interimResults = false;
        maxAlternatives = 1;
        onstart: (() => void) | null = null;
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        onend: (() => void) | null = null;

        start() {
          queueMicrotask(() => this.onstart?.());
        }

        stop() {
          queueMicrotask(() => {
            this.onresult?.({
              resultIndex: 0,
              results: {
                0: {
                  0: { transcript: "疾风剑", confidence: 0.9 },
                  length: 1,
                },
                length: 1,
              },
            });
            this.onend?.();
          });
        }

        abort() {}
      }
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: FakeSpeechRecognition,
      });
    });
  await Promise.all([
    installSpeechRecognition(firstContext),
    installSpeechRecognition(secondContext),
  ]);
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  await Promise.all([first.goto("/"), second.goto("/")]);
  await first.getByLabel("你的称号").fill("赤羽");
  await first.getByRole("button", { name: "快速匹配" }).click();
  await second.getByLabel("你的称号").fill("玄甲");
  await second.getByRole("button", { name: "快速匹配" }).click();

  await Promise.all([
    first.waitForURL(/\/prepare\//),
    second.waitForURL(/\/prepare\//),
  ]);
  await first.getByRole("button", { name: /烈焰剑士/ }).click();
  await second.getByRole("button", { name: /圣光守卫/ }).click();
  await Promise.all([
    first.getByRole("button", { name: "准备出战" }).click(),
    second.getByRole("button", { name: "准备出战" }).click(),
  ]);

  await Promise.all([
    expect(first).toHaveURL(/\/battle\//),
    expect(second).toHaveURL(/\/battle\//),
  ]);
  await expect(first.getByText("ROUND")).toBeVisible();
  await expect(second.getByText("ROUND")).toBeVisible();
  await expect(first.getByRole("button", { name: "浏览器" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(first.getByRole("button", { name: "七牛" })).toBeVisible();

  const cast = first.getByRole("button", { name: "按住发动招式" });
  await cast.dispatchEvent("pointerdown");
  await expect(first.getByText("正在聆听")).toBeVisible();
  await cast.dispatchEvent("pointerup");
  await expect(first.getByText("疾风剑 · 90%")).toBeVisible();
  await expect(first.getByText("ROUND").locator("..")).toContainText("2");

  await firstContext.close();
  await secondContext.close();
});
