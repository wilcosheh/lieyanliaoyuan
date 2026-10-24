export type RecorderState =
  | "idle"
  | "requesting"
  | "recording"
  | "encoding"
  | "error";

export function encodePcm16Wav(
  chunks: Float32Array[],
  sampleRate: number,
): Blob {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) =>
    [...value].forEach((char, index) =>
      view.setUint8(offset + index, char.charCodeAt(0))
    );
  write(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(
        offset,
        clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
        true,
      );
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export class WavRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16_000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.context = new AudioContext({ sampleRate: 16_000 });
    await this.context.audioWorklet.addModule("/audio/pcm-recorder.js");
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "pcm-recorder");
    this.chunks = [];
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) =>
      this.chunks.push(event.data);
    this.source.connect(this.node);
    this.node.connect(this.context.destination);
  }

  async stop(): Promise<Blob> {
    if (!this.context) throw new Error("RECORDER_NOT_STARTED");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result = encodePcm16Wav(this.chunks, this.context.sampleRate);
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context.close();
    this.context = null;
    return result;
  }
}
