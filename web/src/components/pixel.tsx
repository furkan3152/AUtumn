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
        const c = row[start];
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
  ink: "#2a1c12",
  skin: "#f0c193",
  skinShade: "#c98a5a",
  hat: "#3f6fb0",
  hatLight: "#6f9ad6",
  tunic: "#4f8a3a",
  tunicDark: "#356628",
  boot: "#6b3f22",
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
  h: P.hat,
  H: P.hatLight,
  g: P.tunic,
  G: P.tunicDark,
  b: P.boot,
  y: P.gold,
  w: P.white,
};

/* The helper: a small courier in a knit cap. 10 x 14. */
export const HELPER_STAND = [
  "....kk....",
  "...kHHk...",
  "..khhHhk..",
  ".khhhhhhk.",
  ".kkkkkkkk.",
  ".kssssssk.",
  ".kskssksk.",
  ".kssssssk.",
  "..kssssk..",
  ".kgggGggk.",
  "ksgggGgggs",
  ".kgggGggk.",
  "..kbk.kbk.",
  "..kkk.kkk.",
] as const;

export const HELPER_WALK_A = [
  "....kk....",
  "...kHHk...",
  "..khhHhk..",
  ".khhhhhhk.",
  ".kkkkkkkk.",
  ".kssssssk.",
  ".kssksskk.",
  ".kssssssk.",
  "..kssssk..",
  ".kgggGggk.",
  ".sgggGgggs",
  ".kgggGggk.",
  ".kbk...kbk",
  ".kkk...kkk",
] as const;

export const HELPER_WALK_B = [
  "..........",
  "....kk....",
  "...kHHk...",
  "..khhHhk..",
  ".khhhhhhk.",
  ".kkkkkkkk.",
  ".kssssssk.",
  ".kssksskk.",
  "..kssssk..",
  ".kgggGggk.",
  "ksgggGggks",
  ".kgggGggk.",
  "...kbbk...",
  "...kkkk...",
] as const;

/* Sitting, eyes closed. 12 x 11. */
export const HELPER_SIT = [
  "....kk......",
  "...kHHk.....",
  "..khhHhk....",
  ".khhhhhhk...",
  ".kkkkkkkk...",
  ".kssssssk...",
  ".kccsscck...",
  "..kssssk....",
  ".kgggGggk...",
  "ksgggGgggbbk",
  ".kkkkkkkkkkk",
] as const;

export const COIN = [".kk.", "kyyk", "kyyk", ".kk."] as const;
export const coinPalette: Palette = { k: P.goldDark, y: P.gold };

export const Z = ["kkk", "..k", ".k.", "kkk"] as const;
