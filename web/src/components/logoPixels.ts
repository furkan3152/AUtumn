/*
 * Pixel data for the Autumn wordmark: "AU" (the symbol for gold) large and cast
 * like a gold bar (lit top edge, a diagonal shine, a darker base and a cast
 * shadow), "tumn" small in cream, and a gold leaf.
 */

type Px = { x: number; y: number; c: string };

const EDGE = "#3d1a0b";
const SHADOW = "#1c0c05";
/** Gold ramp, top to bottom. */
const RAMP = ["#fff3c4", "#ffe07a", "#f7c843", "#eaaf2c", "#cf8f1d", "#a96a12"];
const SHINE = "#fffbe8";
const CREAM = "#fff1d0";
const CREAM_SHADE = "#e3c58e";

const A = [
  "...###...",
  "..#####..",
  ".###.###.",
  "###...###",
  "###...###",
  "###...###",
  "#########",
  "#########",
  "###...###",
  "###...###",
  "###...###",
  "###...###",
];
const U = [
  "###...###",
  "###...###",
  "###...###",
  "###...###",
  "###...###",
  "###...###",
  "###...###",
  "###...###",
  "###...###",
  "####.####",
  ".#######.",
  "..#####..",
];
const SMALL: Record<string, string[]> = {
  t: [".#..", "####", ".#..", ".#..", ".#..", ".#..", "..##"],
  u: ["#..#", "#..#", "#..#", "#..#", ".###"],
  m: ["####.", "#.#.#", "#.#.#", "#.#.#", "#.#.#"],
  n: ["###.", "#..#", "#..#", "#..#", "#..#"],
};
const LEAF = [".....kkk", "...kklyk", "..klyyyk", ".klyydyk", ".kyydyk.", "kyydkk..", "kdkk....", "s......."];

const key = (x: number, y: number) => `${x},${y}`;

/** Fills, an outline and a one-pixel cast shadow for a set of filled pixels. */
function cast(filled: Set<string>, colour: (x: number, y: number, has: (a: number, b: number) => boolean) => string): Px[] {
  const has = (a: number, b: number) => filled.has(key(a, b));
  const outline = new Set<string>();
  for (const k of filled) {
    const [px, py] = k.split(",").map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (!has(px + dx, py + dy)) outline.add(key(px + dx, py + dy));
  }
  const shadow: Px[] = [];
  for (const k of outline) {
    const [px, py] = k.split(",").map(Number);
    const s = key(px + 1, py + 1);
    if (!outline.has(s) && !filled.has(s)) shadow.push({ x: px + 1, y: py + 1, c: SHADOW });
  }
  const out: Px[] = [...shadow];
  for (const k of outline) {
    const [px, py] = k.split(",").map(Number);
    out.push({ x: px, y: py, c: EDGE });
  }
  for (const k of filled) {
    const [px, py] = k.split(",").map(Number);
    out.push({ x: px, y: py, c: colour(px, py, has) });
  }
  return out;
}

function goldGlyphs(glyphs: string[][], gap: number, ox: number, oy: number): Px[] {
  const filled = new Set<string>();
  let x = ox;
  for (const g of glyphs) {
    g.forEach((row, y) => [...row].forEach((ch, i) => ch === "#" && filled.add(key(x + i, oy + y))));
    x += g[0]!.length + gap;
  }
  const rows = glyphs[0]!.length;
  return cast(filled, (px, py, has) => {
    const r = py - oy;
    let i = Math.min(RAMP.length - 1, 1 + Math.floor((r / rows) * (RAMP.length - 1)));
    if (!has(px, py - 1)) i = 0;
    else if (!has(px - 1, py)) i = Math.max(0, i - 1);
    if (!has(px, py + 1)) i = RAMP.length - 1;
    else if (!has(px + 1, py)) i = Math.min(RAMP.length - 1, i + 1);
    const diag = (px - ox + r) % 13;
    if (r > 0 && r < rows - 3 && (diag === 6 || diag === 7) && has(px, py + 1)) return SHINE;
    return RAMP[i]!;
  });
}

function creamGlyphs(text: string, ox: number, baseline: number): { px: Px[]; end: number } {
  const filled = new Set<string>();
  let x = ox;
  for (const ch of text) {
    const g = SMALL[ch]!;
    g.forEach((row, ry) => [...row].forEach((c, i) => c === "#" && filled.add(key(x + i, baseline - g.length + 1 + ry))));
    x += g[0]!.length + 1;
  }
  return { px: cast(filled, (px, py, has) => (has(px, py + 1) ? CREAM : CREAM_SHADE)), end: x };
}

function leaf(ox: number, oy: number): Px[] {
  const pal: Record<string, string> = { k: EDGE, y: RAMP[2]!, l: RAMP[0]!, d: RAMP[4]!, s: EDGE };
  const out: Px[] = [];
  LEAF.forEach((r, y) => [...r].forEach((ch, x) => pal[ch] && out.push({ x: ox + x, y: oy + y, c: pal[ch]! })));
  return out;
}

export interface LogoPixels {
  width: number;
  height: number;
  px: Px[];
}

/** Full wordmark: AUtumn plus a gold leaf. */
export function wordmark(): LogoPixels {
  const px = goldGlyphs([A, U], 2, 1, 2);
  const small = creamGlyphs("tumn", 23, 13);
  px.push(...small.px);
  px.push(...leaf(small.end + 1, 0));
  return { width: small.end + 10, height: 16, px };
}

/** Compact mark: AU plus a gold leaf at its shoulder. */
export function compactMark(): LogoPixels {
  const px = goldGlyphs([A, U], 2, 1, 4);
  px.push(...leaf(21, 0));
  return { width: 29, height: 18, px };
}

/** Square favicon SVG of the compact mark on a dark wood tile. */
export function faviconSvg(): string {
  const m = compactMark();
  const size = 34;
  const ox = Math.floor((size - m.width) / 2);
  const oy = Math.floor((size - m.height) / 2);
  const e = size - 1;
  const rects = m.px.map((p) => `<rect x="${p.x + ox}" y="${p.y + oy}" width="1" height="1" fill="${p.c}"/>`).join("");
  const tile =
    `<rect x="1" y="0" width="${e - 1}" height="${size}" fill="#2a170c"/><rect x="0" y="1" width="${size}" height="${e - 1}" fill="#2a170c"/>` +
    `<rect x="2" y="1" width="${e - 3}" height="${e - 1}" fill="#5a331a"/><rect x="1" y="2" width="${e - 1}" height="${e - 3}" fill="#5a331a"/>` +
    `<rect x="2" y="2" width="${e - 3}" height="1" fill="#7a4a26"/><rect x="2" y="${e - 3}" width="${e - 3}" height="2" fill="#40230f"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${tile}${rects}</svg>`;
}
