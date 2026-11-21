/* Tiny pixel-map renderer. All art in Autumn is drawn here, in code. */

export type Palette = Record<string, string>;

/** Renders rows of palette characters as SVG rects ('.' is transparent). */
export function Sprite({
  rows,
  palette,
  x = 0,
  y = 0,
  className,
}: {
  rows: readonly string[];
  palette: Palette;
  x?: number;
  y?: number;
  className?: string;
}) {
  const rects: React.ReactElement[] = [];
  rows.forEach((row, ry) => {
    let start = 0;
    for (let i = 1; i <= row.length; i++) {
      if (i === row.length || row[i] !== row[start]) {
        const c = row[start]!;
        if (c !== "." && palette[c]) {
          rects.push(
            <rect key={`${ry}-${start}`} x={x + start} y={y + ry} width={i - start} height={1} fill={palette[c]} />,
          );
        }
        start = i;
      }
    }
  });
  return <g className={className}>{rects}</g>;
}

/* ---------- Palette (original, warm) ---------- */
export const P = {
  ink: "#2a1a10",
  skin: "#f0c193",
  skinShade: "#c98a5a",
  blush: "#e88a74",
  cap: "#3f6e8f",
  capLight: "#6a9bbd",
  scarf: "#c4452f",
  scarfDark: "#8a2a1a",
  coat: "#6b8a3a",
  coatDark: "#475f25",
  trousers: "#5a3a22",
  boot: "#3a2416",
  gold: "#f2bf3a",
  goldLight: "#ffe58a",
  goldDark: "#b8801c",
  wood: "#9a6034",
  woodDark: "#64391b",
  woodLight: "#c48a52",
  iron: "#55606b",
  cream: "#fbefd2",
  red: "#c4452f",
  white: "#ffffff",
} as const;

export const helperPalette: Palette = {
  k: P.ink,
  s: P.skin,
  c: P.skinShade,
  o: P.blush,
  h: P.cap,
  H: P.capLight,
  r: P.scarf,
  R: P.scarfDark,
  g: P.coat,
  G: P.coatDark,
  p: P.trousers,
  q: "#3e2716",
  b: P.boot,
};

/* The helper: a small courier in a knit cap and a red scarf, facing right. 11 x 16. */
const HEAD = [
  "....kkkk...",
  "...kHHhhk..",
  "..kHhhhhhk.",
  "..khhhhhhhk",
  ".kkkkkkkkkk",
  ".ksssssssk.",
  ".ksssksksk.",
  ".ksssssosk.",
  "..krrrrrrk.",
] as const;
const HEAD_BLINK = [...HEAD.slice(0, 6), ".ksssssssk.", ".ksskkskkk.", "..krrrrrrk."] as const;

export const HELPER_STAND = [
  ...HEAD,
  ".kgggrRgggk",
  "kgkggrggkgk",
  "kskgggggksk",
  ".kGGGGGGGk.",
  "..kppkppk..",
  "..kbbkbbk..",
  "..kkk.kkk..",
] as const;

export const HELPER_BLINK = [...HEAD_BLINK, ...HELPER_STAND.slice(9)] as const;

/** Stride: front leg forward, arms swinging. */
export const HELPER_WALK_A = [
  ...HEAD,
  ".kgggrRgggk",
  "kgkggrgggkk",
  "ksgggggggsk",
  ".kGGGGGGGk.",
  ".kppk.kqqk.",
  "kbbk...kbbk",
  "kkk.....kkk",
] as const;

/** Passing: legs together, body one pixel up. */
export const HELPER_WALK_B = [
  "...........",
  ...HEAD,
  ".kgggrRgggk",
  "kgkggrggkgk",
  "kskgggggksk",
  ".kGGGGGGGk.",
  "...kppqk...",
  "...kbbbk...",
] as const;

/** Stride with the other leg forward. */
export const HELPER_WALK_C = [
  ...HEAD,
  ".kgggrRgggk",
  "kkgggrggkgk",
  "ksgggggggsk",
  ".kGGGGGGGk.",
  ".kqqk.kppk.",
  "kbbk...kbbk",
  "kkk.....kkk",
] as const;

/* Sitting on a log by the fire, eyes closed. 13 x 13. */
export const HELPER_SIT = [
  "....kkkk.....",
  "...kHHhhk....",
  "..kHhhhhhk...",
  "..khhhhhhhk..",
  ".kkkkkkkkkk..",
  ".ksssssssk...",
  ".ksskkskkk...",
  ".ksssssosk...",
  "..krrrrrrk...",
  ".kgggrRgggk..",
  "kskggrgggskk.",
  ".kGGGGGGppppk",
  "..kkkkkkkbbbk",
] as const;

export const LOG = [".kkkkkkkkkkkk.", "kbnnnnnnnnnnbk", "kBbbbbbbbbbbBk", ".kkkkkkkkkkkk."] as const;

export const COIN = [".kk.", "kylk", "kyyk", ".kk."] as const;
export const coinPalette: Palette = { k: P.goldDark, y: P.gold, l: P.goldLight };

export const Z = ["kkk", "..k", ".k.", "kkk"] as const;
