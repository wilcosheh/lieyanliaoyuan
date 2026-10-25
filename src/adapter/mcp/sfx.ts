import { SFX_NAMES, type SfxName } from "../../game/logic.ts";

const RATE = 16_000;

export function isSfxName(name: string): name is SfxName {
  return (SFX_NAMES as readonly string[]).includes(name);
}

export function synthWav(name: SfxName): Uint8Array {
  const samples = render(name);
  return wavFromSamples(samples, RATE);
}

function render(name: SfxName): Float32Array {
  switch (name) {
    case "huoshi":
      return tone(
        0.28,
        (t) => Math.sin(2 * Math.PI * (520 + t * 900) * t) * env(t, 0.28),
      );
    case "shuimu":
      return tone(
        0.45,
        (t) =>
          Math.sin(2 * Math.PI * 240 * t) * (0.6 + 0.4 * Math.sin(40 * t)) *
          env(t, 0.45),
      );
    case "hanshuang":
      return tone(
        0.4,
        (t) =>
          Math.sin(2 * Math.PI * 1400 * t) * Math.sin(2 * Math.PI * 18 * t) *
          env(t, 0.4),
      );
    case "lieyan":
      return tone(
        0.55,
        (t) => noise(t) * Math.sin(2 * Math.PI * 90 * t) * env(t, 0.55),
      );
    case "jiutian":
      return tone(
        0.7,
        (t) =>
          (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 330 * t) +
            Math.sin(2 * Math.PI * 440 * t)) /
          3 * env(t, 0.7),
      );
    case "duan":
      return tone(0.16, (t) => noise(t) * env(t, 0.16));
    case "sheng":
      return tone(0.55, (t) => {
        const f = t < 0.18 ? 523 : t < 0.36 ? 659 : 784;
        return Math.sin(2 * Math.PI * f * t) * env(t, 0.55);
      });
    case "bai":
      return tone(
        0.5,
        (t) => Math.sin(2 * Math.PI * (440 - t * 280) * t) * env(t, 0.5),
      );
    case "bao":
      return tone(0.22, (t) => Math.sin(2 * Math.PI * 880 * t) * env(t, 0.22));
    case "ping":
      return tone(0.36, (t) => {
        const f = t < 0.18 ? 392 : 494;
        return Math.sin(2 * Math.PI * f * t) * env(t, 0.36);
      });
  }
}

function tone(seconds: number, fn: (t: number) => number): Float32Array {
  const n = Math.floor(RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = clamp(fn(i / RATE));
  return out;
}

function env(t: number, seconds: number): number {
  const a = Math.min(1, t / 0.02);
  const r = Math.min(1, (seconds - t) / 0.05);
  return Math.max(0, Math.min(a, r));
}

function noise(t: number): number {
  const x = Math.sin(t * 12543.1) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function clamp(n: number): number {
  return Math.max(-1, Math.min(1, n));
}

function wavFromSamples(samples: Float32Array, rate: number): Uint8Array {
  const bytes = 44 + samples.length * 2;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  write(view, 0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  write(view, 8, "WAVE");
  write(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function write(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
