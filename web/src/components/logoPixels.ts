/* Pixel data for the Autumn wordmark: "AU" (the symbol for gold) large and gold, "tumn" small. */

type Px = { x: number; y: number; c: string };

const GOLD = "#f2bf3a";
const GOLD_LIGHT = "#fff0a6";
const GOLD_DARK = "#b8801c";
const EDGE = "#5a2a16";
const INK = "#4a2412";

const A = ["..###..", ".##.##.", "##...##", "##...##", "#######", "##...##", "##...##", "##...##", "##...##"];
const U = ["##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", ".#####.", "..###.."];
const SMALL: Record<string, string[]> = {
  t: [".#..", "###.", ".#..", ".#..", ".#..", "..##"],
  u: ["#..#", "#..#", "#..#", "#..#", ".###"],
  m: ["####.", "#.#.#", "#.#.#", "#.#.#", "#.#.#"],
  n: ["###.", "#..#", "#..#", "#..#", "#..#"],
};
const LEAF = ["...dd.", "..dyld", ".dyyyd", "dyyyd.", "dyd...", "s....."];

function goldGlyphs(glyphs: string[][], gap: number, ox: number, oy: number): Px[] {
  const filled = new Set<string>();
  let x = ox;
  for (const g of glyphs) {
    g.forEach((row, y) => [...row].forEach((ch, i) => ch === "#" && filled.add(`${x + i},${oy + y}`)));
    x += g[0].length + gap;
  }
  const has = (a: number, b: number) => filled.has(`${a},${b}`);
  const out: Px[] = [];
  const outline = new Set<string>();
  for (const key of filled) {
    const [px, py] = key.split(",").map(Number);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) if (!has(px + dx, py + dy)) outline.add(`${px + dx},${py + dy}`);
    let c = GOLD;
    if (!has(px, py - 1) || !has(px - 1, py)) c = GOLD_LIGHT;
    if (!has(px, py + 1) || !has(px + 1, py)) c = GOLD_DARK;
    out.push({ x: px, y: py, c });
  }
  for (const key of outline) {
    const [px, py] = key.split(",").map(Number);
    out.push({ x: px, y: py, c: EDGE });
  }
  return out;
}

function leaf(ox: number, oy: number): Px[] {
  const pal: Record<string, string> = { d: GOLD_DARK, y: GOLD, l: GOLD_LIGHT, s: EDGE };
  const out: Px[] = [];
  LEAF.forEach((r, y) => [...r].forEach((ch, x) => pal[ch] && out.push({ x: ox + x, y: oy + y, c: pal[ch] })));
  return out;
}

export interface LogoPixels {
  width: number;
  height: number;
  px: Px[];
}

/** Full wordmark: AUtumn plus a gold leaf. */
export function wordmark(): LogoPixels {
  const px = goldGlyphs([A, U], 2, 1, 1);
  let x = 19;
  const baseline = 9;
  for (const ch of "tumn") {
    const g = SMALL[ch];
    g.forEach((row, ry) =>
      [...row].forEach((c, i) => c === "#" && px.push({ x: x + i, y: baseline - g.length + 1 + ry, c: INK })),
    );
    x += g[0].length + 1;
  }
  px.push(...leaf(x, 0));
  return { width: x + 7, height: 11, px };
}

/** Compact mark: AU plus a gold leaf. */
export function compactMark(): LogoPixels {
  const px = goldGlyphs([A, U], 2, 1, 1);
  px.push(...leaf(19, 0));
  return { width: 26, height: 11, px };
}

/** Square favicon SVG of the compact mark. */
export function faviconSvg(): string {
  const m = compactMark();
  const size = 28;
  const ox = Math.floor((size - m.width) / 2);
  const oy = Math.floor((size - m.height) / 2);
  const rects = m.px.map((p) => `<rect x="${p.x + ox}" y="${p.y + oy}" width="1" height="1" fill="${p.c}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" rx="4" fill="#fbefd2"/>${rects}</svg>`;
}
