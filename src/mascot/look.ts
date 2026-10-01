export type RGB = [number, number, number];

export interface Look {
  top: RGB;
  bottom: RGB;
  ink: string;
  inkMini: string;
  sparkle: boolean;
  dome: number;
  base: number;
  aspect: number;
}

export const LOOK: Look = {
  top: [0.97, 0.97, 0.98],
  bottom: [0.79, 0.8, 0.84],
  ink: "rgb(24,22,30)",
  inkMini: "rgb(18,19,26)",
  sparkle: true,
  dome: 2.35,
  base: 2.9,
  aspect: 1.02,
};

export const TAKO_SPARK = "rgba(255,255,255,0.92)";

export function takoPoint(a: number, rx: number, ry: number): { x: number; y: number } {
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const bottom = sa > 0;
  const e = bottom ? 2 / LOOK.base : 2 / LOOK.dome;
  let x = rx * Math.sign(ca) * Math.pow(Math.abs(ca), e);
  const y = ry * Math.sign(sa) * Math.pow(Math.abs(sa), e);
  if (bottom) x *= 1 + 0.05 * sa;
  return { x, y };
}

export function takoPath(rx: number, ry: number, steps = 120): Path2D {
  const p = new Path2D();
  for (let i = 0; i <= steps; i++) {
    const { x, y } = takoPoint((i / steps) * Math.PI * 2, rx, ry);
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

export function rgb(c: RGB, alpha = 1): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${alpha})`;
}
