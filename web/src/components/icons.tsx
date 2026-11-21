/* Small pixel icons, one per kind of fact. Drawn in code; decorative (aria-hidden). */

import { Sprite, type Palette } from "./pixel";

const PAL: Palette = {
  k: "#2a1a10",
  y: "#f2bf3a",
  l: "#ffe58a",
  d: "#b8801c",
  w: "#fff4d8",
  p: "#ead3a0",
  P: "#c9a46a",
  g: "#5d8a3a",
  G: "#3d6128",
  m: "#8fbf5a",
  r: "#c4452f",
  R: "#8a2a1a",
  o: "#e0782c",
  b: "#9a6034",
  B: "#64391b",
  n: "#c48a52",
  s: "#c9cfd6",
  S: "#7b8794",
  t: "#4f86b0",
  T: "#2a4d66",
  a: "#ffcf5a",
  e: "#f6a8a0",
};

export const ICON_ROWS = {
  coin: ["..kkkkk..", ".klllyyk.", "klyykyydk", "klykkkydk", "kyyykyydk", "kyyyyyydk", "kyyyyyddk", ".kdddddk.", "..kkkkk.."],
  bar: ["..........", "..kkkkkk..", ".kllllyyk.", "kllyyyyydk", "kyyyyyyydk", "kddddddddk", "kkkkkkkkkk", ".........."],
  note: ["...........", "kkkkkkkkkkk", "kmggggggGGk", "kggggkggggk", "kgggkmkgggk", "kggggkggggk", "kgggggggGGk", "kGGGGGGGGGk", "kkkkkkkkkkk", "..........."],
  token: ["..kkkkk..", ".kwwsssk.", "kwsssssSk", "kssSSSsSk", "kssSkSsSk", "kssSSSsSk", "ksssssSSk", ".kSSSSSk.", "..kkkkk.."],
  calendar: [".kk....kk.", "kkkkkkkkkk", "krrrrrrrRk", "kkkkkkkkkk", "kwwwwwwwPk", "kwkwkwkwPk", "kwwwwwwwPk", "kwkwkwrwPk", "kPPPPPPPPk", "kkkkkkkkkk"],
  pouch: ["...k..k...", "....kk....", "...kyyk...", "...kbbk...", "..kbnbbk..", ".kbnbbbbk.", "kbnbbbbbBk", "kbbbbbbbBk", ".kBbbbbBk.", "..kkkkkk.."],
  shield: ["kkkkkkkkkk", "kwwwwgggGk", "kwwwwgggGk", "kwwwwgggGk", "kggggwwwPk", "kggggwwwPk", ".kgggwwPk.", "..kggwPk..", "...kgPk...", "....kk...."],
  lock: ["...kkkk...", "..ksSSsk..", "..ks..Sk..", "..ks..Sk..", ".kkkkkkkk.", ".klyyyydk.", ".kyykkydk.", ".kyykkydk.", ".kyyyyddk.", ".kkkkkkkk."],
  hourglass: ["kkkkkkkkk", "kBnnnnnBk", ".kwwwwwk.", "..kwyyk..", "...kyk...", "...kyk...", "..kwyyk..", ".kwyyyyk.", "kBnnnnnBk", "kkkkkkkkk"],
  wallet: ["..kkkkkk..", ".kwwwwwwk.", "kkkkkkkkkk", "kbnnnnnnbk", "kbbbbbkkkk", "kbbbbbkyyk", "kbbbbbkkkk", "kBBBBBBBBk", "kkkkkkkkkk"],
  leaf: [".....kkk.", "...kkoook", "..koooolk", ".kooolook", ".koolook.", "koolokk..", "kolkk....", "kRk......", "kk......."],
  key: ["..........", ".kkk......", "kyllk.....", "kykkykkkkk", "kykkyyyyyk", "kyyydkykyk", ".kkkk.k.k.", ".........."],
  scroll: [".kkkkkkk..", "kPwwwwwwk.", "kPkkkkkwk.", ".kwwwwwwk.", ".kwkkkkwk.", ".kwwwwwwk.", ".kwkkkwwk.", ".kwwwwwwkk", ".kkkkkkkPk", "..kkkkkkk."],
  no: ["kk.....kk", "krk...kRk", ".krk.kRk.", "..krkRk..", "...kRk...", "..krkRk..", ".krk.kRk.", "krk...kRk", "kk.....kk"],
  stop: ["..kkkkk..", ".krrrrrk.", "krrrrrrRk", "krwwwwwRk", "krwwwwwRk", "krrrrrrRk", "kRrrrrRRk", ".kRRRRRk.", "..kkkkk.."],
  check: [".......kk", "......kmk", ".....kmgk", "kk..kmgk.", "kmkkmgk..", "kgmmgk...", ".kggk....", "..kk....."],
  send: ["...kkkkkk", "...kllyyk", "....kyyyk", "...kyyyyk", "..kyyykyk", ".kyyyk.kk", "kyyyk....", "kyyk.....", ".kk......"],
  id: ["kkkkkkkkkk", "kwwwwwwwwk", "kwssswkkwk", "kwsksswwwk", "kwssswkkwk", "kwtttwwwwk", "kPPPPPPPPk", "kkkkkkkkkk"],
  globe: ["..kkkkk..", ".kttmmtk.", "ktmmmttTk", "kttmmttTk", "kttttmmTk", "kmtttmmTk", "kttttttTk", ".kTTTTTk.", "..kkkkk.."],
  seal: ["...kkkkk...", "..krrrrrk..", ".krreerrRk.", "krrerRRrrRk", "krrRrrrRrRk", "krrRrrrRrRk", "krrRrrrRrRk", "krrrRRRrRRk", ".kRrrrrRRk.", "..kRRRRRk..", "...kkkkk..."],
  chest: ["..........", ".kkkkkkkk.", "kbnnnnnnbk", "kBkkyykkBk", "kkkkyykkkk", "kbbbkkbbbk", "kbbbbbbbbk", "kBBBBBBBBk", "kkkkkkkkkk", ".........."],
  passkey: ["..kkkkk...", ".kwwwwwk..", "kwkwwwkwk.", "kwwwkwwwk.", "kwwkkkwwk.", "kwwwkwwwk.", ".kwwkwwk..", "..kwkwk...", "...kkk...."],
} as const;

export type IconName = keyof typeof ICON_ROWS;

/** A pixel icon. Decorative: the text next to it carries the meaning. */
export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const rows = ICON_ROWS[name];
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const s = Math.max(w, h);
  return (
    <svg
      className={`icon ${className}`}
      viewBox={`0 0 ${s} ${s}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <Sprite rows={rows} palette={PAL} x={Math.floor((s - w) / 2)} y={Math.floor((s - h) / 2)} />
    </svg>
  );
}
