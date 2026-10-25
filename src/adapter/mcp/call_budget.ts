const GRACE_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 预算到点不能把已经算完、或即将写上的引擎结果换成兜底句。
 * 超时后仍等原调用结束；只有它失败或迟迟不回来，才走 fallback。
 */
export async function settleHubCall<T>(
  work: Promise<T>,
  budgetMs: number,
  fallback: (error: unknown) => Promise<T>,
): Promise<T> {
  const box: { value?: T; done: boolean } = { done: false };
  const tracked = work.then((value) => {
    box.value = value;
    box.done = true;
    return value;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      tracked,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`mcp call budget ${budgetMs}ms`)),
          budgetMs,
        );
      }),
    ]);
  } catch (error) {
    if (box.done) return box.value as T;
    await Promise.race([
      tracked.then(() => undefined).catch(() => undefined),
      sleep(GRACE_MS),
    ]);
    if (box.done) return box.value as T;
    return await fallback(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
