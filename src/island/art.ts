const cache = new Map<string, string | null>();
const BUCKETS = 12;
const SAMPLE = 24;

export function hsl(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [h / 6, s, l];
}

export function pickColor(data: ArrayLike<number>): string | null {
  const buckets = Array.from({ length: BUCKETS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 128) continue;
    const [h, s, l] = hsl(r, g, b);
    if (s < 0.22 || l < 0.12 || l > 0.92) continue;
    const w = s * (1 - Math.abs(l - 0.5) * 1.3);
    const bucket = buckets[Math.floor(h * BUCKETS) % BUCKETS];
    bucket.w += w;
    bucket.r += r * w;
    bucket.g += g * w;
    bucket.b += b * w;
  }
  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
  if (best.w < 1.5) return null;
  const [h, s, l] = hsl(best.r / best.w, best.g / best.w, best.b / best.w);
  const sat = Math.min(0.95, Math.max(0.55, s));
  const light = Math.min(0.72, Math.max(0.6, l));
  return `hsl(${Math.round(h * 360)} ${Math.round(sat * 100)}% ${Math.round(light * 100)}%)`;
}

export async function artColor(src: string): Promise<string | null> {
  const key = `${src.length}:${src.slice(-64)}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    cache.set(key, null);
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
  const color = pickColor(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  if (cache.size > 40) cache.clear();
  cache.set(key, color);
  return color;
}
