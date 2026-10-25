export type ClockFields = {
  opensAt: number | null;
  ackDeadline: number | null;
  disconnectDeadline: number | null;
  cpuCompleteAt: number | null;
};

export type DueKind = "open" | "ack" | "disconnect" | "cpu";

/** 一句「三。二。一。」的时长。灵矽实测后再改。 */
export const COUNTDOWN_MS = 3000;

/** 回执超时后仍进入倒数。 */
export const ACK_MS = 5000;

/** 每个汉字的电脑施法时间。终端附加时间在对局开始时写入。 */
export const CPU_MS_PER_GRAPHEME = 400;

export const VOICE_CPU_EXTRA_MS = 2000;

export function due(fields: ClockFields, now: number): DueKind[] {
  const items: DueKind[] = [];
  if (fields.opensAt !== null && now >= fields.opensAt) items.push("open");
  if (fields.ackDeadline !== null && now >= fields.ackDeadline) {
    items.push("ack");
  }
  if (
    fields.disconnectDeadline !== null && now >= fields.disconnectDeadline
  ) {
    items.push("disconnect");
  }
  if (fields.cpuCompleteAt !== null && now >= fields.cpuCompleteAt) {
    items.push("cpu");
  }
  return items;
}
