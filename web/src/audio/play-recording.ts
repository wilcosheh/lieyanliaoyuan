"use client";

/** 在技能已经被服务器接受后回放本次玩家的原始录音。 */
export function playRecordedAudio(audio: Blob): void {
  if (typeof Audio === "undefined" || typeof URL === "undefined") return;
  const url = URL.createObjectURL(audio);
  const player = new Audio(url);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    URL.revokeObjectURL(url);
  };
  player.onended = release;
  player.onerror = release;
  void player.play().catch(release);
}
