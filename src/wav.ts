export interface Clip {
  sampleRate: number;
  pcm: Int16Array;
}

export interface Timing {
  /** Start of the sentence in the chapter file, in seconds. */
  start: number;
  /** End of the spoken audio of the sentence, in seconds. */
  end: number;
}

export interface Chapter {
  blob: Blob;
  timings: Timing[];
  duration: number;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Join sentence clips into one 16-bit mono WAV file.
 * `gapsMs[i]` is the silence after clip i.
 */
export function joinClips(clips: Clip[], gapsMs: number[]): Chapter {
  const first = clips[0];
  if (!first) throw new Error("No clips to join.");
  const rate = first.sampleRate;
  const gapSamples = gapsMs.map((ms) => Math.round((ms / 1000) * rate));
  let total = 0;
  clips.forEach((clip, i) => {
    total += clip.pcm.length + (gapSamples[i] ?? 0);
  });

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, total * 2, true);

  const pcm = new Int16Array(total);
  const timings: Timing[] = [];
  let offset = 0;
  clips.forEach((clip, i) => {
    pcm.set(clip.pcm, offset);
    timings.push({ start: offset / rate, end: (offset + clip.pcm.length) / rate });
    offset += clip.pcm.length + (gapSamples[i] ?? 0);
  });

  return {
    blob: new Blob([header, pcm], { type: "audio/wav" }),
    timings,
    duration: total / rate,
  };
}
