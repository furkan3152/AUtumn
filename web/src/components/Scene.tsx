"use client";

import { useEffect, useRef, useState } from "react";
import {
  COIN,
  HELPER_BLINK,
  HELPER_SIT,
  HELPER_STAND,
  HELPER_WALK_A,
  HELPER_WALK_B,
  HELPER_WALK_C,
  LOG,
  P,
  Sprite,
  Z,
  coinPalette,
  helperPalette,
  type Palette,
} from "./pixel";

/*
 * The little world. 240 x 120 pixels, drawn in code. Real state drives it:
 * the chest fills in stages as gold grows, the row of lanterns lights up as
 * this period's limit is used, the helper walks to the stall and back with a
 * coin when a purchase lands, and sits by a fire when the agent is stopped.
 * The sky follows the visitor's local time.
 */

const W = 240;
const H = 120;
const HOME_X = 76;
const STALL_X = 140;
const HELPER_Y = 86;
export const TRIP_MS = 6000;
const POSTS = 10;
const POST_X0 = 93;
const POST_GAP = 5;

export type SceneMode = "intro" | "active" | "stopping" | "stopped" | "expired";
type Phase = "dawn" | "day" | "dusk" | "night";

export interface SceneProps {
  mode: SceneMode;
  /** 0..1 how full the chest is. */
  chestFill: number;
  /** 0..1 share of this week's limit used. */
  limitUsed: number;
  /** Changes whenever a new purchase lands; triggers the walk to the stall. */
  purchaseKey?: string;
  /** Plain-language description for screen readers. */
  label: string;
  /** Text on the sign when the agent is not running. */
  signText?: string;
  /** "hero" fills its box (landing); "window" keeps the whole picture visible. */
  variant?: "hero" | "window";
  children?: React.ReactNode;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

function phaseAt(d = new Date()): Phase {
  const h = d.getHours();
  if (h >= 5 && h < 8) return "dawn";
  if (h >= 8 && h < 17) return "day";
  if (h >= 17 && h < 20) return "dusk";
  return "night";
}

export function Scene({ mode, chestFill, limitUsed, purchaseKey, label, signText, variant = "window", children }: SceneProps) {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState<Phase>(() => (typeof window === "undefined" ? "day" : phaseAt()));
  useEffect(() => {
    setPhase(phaseAt());
    const t = setInterval(() => setPhase(phaseAt()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Walk to the stall when a new purchase lands. Chest and lanterns update when the helper is back.
  const prevKey = useRef(purchaseKey);
  const prevFill = useRef({ chestFill, limitUsed });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trip, setTrip] = useState<{ id: number; chestFill: number; limitUsed: number } | null>(null);

  useEffect(() => {
    if (prevKey.current === purchaseKey) return;
    prevKey.current = purchaseKey;
    if (!purchaseKey || reduced || mode !== "active") return;
    setTrip({ id: Date.now(), ...prevFill.current });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setTrip(null), TRIP_MS);
  }, [purchaseKey, reduced, mode]);

  useEffect(() => {
    prevFill.current = { chestFill, limitUsed };
  }, [chestFill, limitUsed]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const shownFill = trip ? trip.chestFill : chestFill;
  const shownUsed = trip ? trip.limitUsed : limitUsed;
  const level = shownFill <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil(shownFill * 5)));
  const lit = Math.min(POSTS, Math.round(shownUsed * POSTS));
  const resting = mode === "stopped" || mode === "expired";
  const dark = phase === "night" || phase === "dusk";

  return (
    <div className={`scene scene--${variant} scene--${phase} ${reduced ? "scene--still" : ""}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio={variant === "hero" ? "xMidYMax slice" : "xMidYMid meet"}
        shapeRendering="crispEdges"
        role="img"
        aria-label={label}
        className="scene__svg"
      >
        <Sky phase={phase} />
        <g className="layer layer--far">
          <Sprite rows={FAR_HILLS} palette={FAR_PAL[phase]} x={-10} y={46} />
        </g>
        <g className="layer layer--mid">
          <Sprite rows={TREELINE} palette={TREE_PAL[phase]} x={-10} y={60} />
        </g>
        <Ground />
        <Cottage />
        <BigTree />
        <Stall />
        {mode !== "intro" && !resting && <Posts lit={lit} />}
        {resting && <SignPosts />}
        <Props />
        <Chest level={level} />
        {resting ? (
          <Campfire />
        ) : trip ? (
          <WalkingHelper key={trip.id} />
        ) : (
          <IdleHelper still={mode === "stopping"} />
        )}
        <Tufts />
        <Overlay phase={phase} />
        <Glows dark={dark} lit={mode !== "intro" && !resting ? lit : 0} resting={resting} />
        {resting && <SleepingZ />}
        {trip && <CoinPop key={`pop${trip.id}`} />}
        <FallingLeaves />
      </svg>
      {resting && signText && (
        <div className="scene__sign" aria-hidden="true">
          {signText}
        </div>
      )}
      {children}
    </div>
  );
}

/* ---------- Deterministic noise for procedural layers ---------- */

function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function grid(w: number, h: number, fill = ".") {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => fill));
}

const FAR_HILLS = (() => {
  const w = W + 20;
  const h = 26;
  const g = grid(w, h);
  for (let x = 0; x < w; x++) {
    const top = Math.round(11 - 6 * Math.sin(x / 26) - 3 * Math.sin(x / 11 + 1.3));
    for (let y = Math.max(0, top); y < h; y++) g[y]![x] = y === top ? "l" : y > top + 6 && (x + y) % 2 === 0 && y > 16 ? "d" : "h";
  }
  return g.map((r) => r.join(""));
})();

const FAR_PAL: Record<Phase, Palette> = {
  dawn: { h: "#8a7aa6", l: "#a896bd", d: "#7a6b98" },
  day: { h: "#8fa6b8", l: "#a9bccb", d: "#7e97ab" },
  dusk: { h: "#7a4f7e", l: "#94638f", d: "#6a4470" },
  night: { h: "#2a3560", l: "#34416f", d: "#232d53" },
};

const TREELINE = (() => {
  const w = W + 20;
  const h = 22;
  const g = grid(w, h);
  const r = rand(7);
  // ground strip
  for (let x = 0; x < w; x++) for (let y = 16; y < h; y++) g[y]![x] = "g";
  let x = 2;
  while (x < w) {
    const rad = 3 + Math.floor(r() * 3);
    const cy = 12 - rad + Math.floor(r() * 3);
    const tone = ["a", "b", "c", "e"][Math.floor(r() * 4)]!;
    for (let yy = 0; yy < h; yy++)
      for (let xx = -rad; xx <= rad; xx++) {
        const dx = xx;
        const dy = yy - cy;
        if (dx * dx + dy * dy * 1.3 <= rad * rad + 1) {
          const px = x + xx;
          if (px < 0 || px >= w || yy >= 16) continue;
          g[yy]![px] = dx + dy > rad / 2 ? "d" : dx + dy < -rad ? "l" : tone;
        }
      }
    for (let yy = cy + rad; yy < 16; yy++) if (x < w) g[yy]![x] = "t";
    x += rad + 2 + Math.floor(r() * 4);
  }
  return g.map((row) => row.join(""));
})();

const TREE_PAL: Record<Phase, Palette> = {
  dawn: { a: "#b4583a", b: "#c88a3c", c: "#8a5a3e", e: "#9a7a3a", d: "#6a3e34", l: "#d8a05a", t: "#4a2a20", g: "#7a6a3a" },
  day: { a: "#c4602e", b: "#d89a32", c: "#a2482a", e: "#8f8a36", d: "#7a3a22", l: "#ecbc5a", t: "#5a321c", g: "#8a7a3a" },
  dusk: { a: "#a8483a", b: "#b87038", c: "#7e3a34", e: "#7a6034", d: "#5a2a2e", l: "#cc8448", t: "#3e2020", g: "#6a5034" },
  night: { a: "#3e3a4e", b: "#4a4450", c: "#36304a", e: "#3a3e48", d: "#28263a", l: "#565068", t: "#201c2a", g: "#2e2e3a" },
};

/* ---------- Sky ---------- */

const SKY: Record<Phase, string[]> = {
  dawn: ["#4b5a92", "#6e6ea6", "#9a80ae", "#d39aa6", "#f2b98f", "#f8d6a0"],
  day: ["#6aa0d4", "#7cadda", "#90bbe0", "#a6c9e4", "#bcd6e6", "#d6e4e0"],
  dusk: ["#2f2f6a", "#55407c", "#8a4f84", "#c2607a", "#ea8a5e", "#f6b768"],
  night: ["#10163a", "#151c44", "#1b244f", "#212c5a", "#283565", "#2f3e70"],
};

const STARS = [
  [8, 6], [22, 15], [37, 4], [51, 22], [66, 9], [80, 18], [94, 5], [108, 26], [121, 12], [136, 3],
  [148, 20], [163, 8], [177, 27], [214, 6], [228, 19], [236, 31], [14, 34], [58, 36], [128, 38], [100, 40],
];

function Sky({ phase }: { phase: Phase }) {
  const bands = SKY[phase];
  return (
    <g>
      {bands.map((c, i) => (
        <rect key={c} x={0} y={i * 10} width={W} height={i === bands.length - 1 ? 60 : 10} fill={c} />
      ))}
      {/* dithered band edges */}
      {bands.slice(1).map((c, i) => (
        <g key={`d${c}`} fill={c}>
          {Array.from({ length: W / 4 }, (_, k) => (
            <rect key={k} x={k * 4 + ((i % 2) * 2)} y={(i + 1) * 10 - 1} width={2} height={1} />
          ))}
        </g>
      ))}
      {(phase === "night" || phase === "dusk") &&
        STARS.slice(0, phase === "night" ? STARS.length : 8).map(([x, y], i) => (
          <rect key={i} className={`twinkle twinkle--${i % 3}`} x={x} y={y} width={1} height={1} fill="#fff6c8" />
        ))}
      {phase === "night" && (
        <>
          {[[30, 12], [150, 14], [204, 30]].map(([x, y]) => (
            <Sprite key={x} x={x! - 1} y={y! - 1} palette={{ s: "#fff6c8", f: "#8a90b8" }} rows={[".f.", "fsf", ".f."]} className="twinkle twinkle--1" />
          ))}
          <Sprite
            x={194}
            y={18}
            palette={{ m: "#f4ecc8", d: "#d8cc9a", h: "#fffbe6", g: "#3a4880" }}
            rows={["...mmmmm...", "..mhmmmmmg.", ".mhmmmdmmmg", "mmmmmmmmdmg", "mmdmmmmmmmg", "mmmmmmmmmmg", "mmmmmdmmmmg", ".mmdmmmmmg.", "..mmmmmmg..", "...ggggg..."]}
          />
        </>
      )}
      {phase !== "night" && (
        <Sprite
          x={phase === "day" ? 194 : phase === "dawn" ? 34 : 180}
          y={phase === "day" ? 20 : 34}
          palette={
            phase === "day"
              ? { o: "#ffe27a", c: "#fff6c4", r: "#ffcd4a" }
              : phase === "dawn"
                ? { o: "#ffc46b", c: "#ffe7b0", r: "#f29a4a" }
                : { o: "#ff9a4a", c: "#ffd08a", r: "#e2603a" }
          }
          rows={["...rrrr...", ".rroooorr.", ".roccoooor", "rocccooooR", "rocooooooR", "rooooooooR", "roooooooor", ".rooooooR.", ".rrooooRr.", "...rrrr..."].map((r) =>
            r.replace(/R/g, "r"),
          )}
        />
      )}
      <g className="cloud cloud--a">
        <Cloud x={18} y={12} phase={phase} />
      </g>
      <g className="cloud cloud--b">
        <Cloud x={112} y={24} phase={phase} />
      </g>
      <g className="cloud cloud--c">
        <Cloud x={168} y={4} phase={phase} small />
      </g>
      {phase !== "night" && <Birds />}
    </g>
  );
}

const CLOUD_PAL: Record<Phase, Palette> = {
  dawn: { w: "#f6d8d0", g: "#c9a0b4", h: "#fff0e8" },
  day: { w: "#f6f8f4", g: "#c6d6e2", h: "#ffffff" },
  dusk: { w: "#f0a890", g: "#a86a88", h: "#ffc8a8" },
  night: { w: "#36416e", g: "#262f58", h: "#46527e" },
};

function Cloud({ x, y, phase, small }: { x: number; y: number; phase: Phase; small?: boolean }) {
  const rows = small
    ? ["...hhh....", ".hhwwwhh..", "hwwwwwwwh.", "gggggggggg"]
    : ["......hhhh........", "....hhwwwwhh.hhh..", "..hhwwwwwwwwhwwwh.", ".hwwwwwwwwwwwwwwwh", "hwwwwwwwwwwwwwwwww", "gggggggggggggggggg"];
  return <Sprite x={x} y={y} palette={CLOUD_PAL[phase]} rows={rows} />;
}

function Birds() {
  const pal = { k: "#3a2a3a" };
  return (
    <g className="birds">
      {[
        [0, 0],
        [7, 3],
        [-6, 4],
      ].map(([dx, dy], i) => (
        <g key={i}>
          <Sprite className="wing-a" x={-20 + dx!} y={20 + dy!} palette={pal} rows={["k...k", ".k.k.", "..k.."]} />
          <Sprite className="wing-b" x={-20 + dx!} y={20 + dy!} palette={pal} rows={[".....", "kk.kk", "..k.."]} />
        </g>
      ))}
    </g>
  );
}

/* ---------- Ground ---------- */

const GROUND_SPECKS = (() => {
  const r = rand(42);
  const g = grid(W, 42);
  for (let y = 0; y < 42; y++)
    for (let x = 0; x < W; x++) {
      const v = r();
      if (v < 0.035) g[y]![x] = "x";
      else if (v < 0.05) g[y]![x] = "y";
    }
  return g.map((row) => row.join(""));
})();

function Ground() {
  return (
    <g>
      <rect x={0} y={78} width={W} height={H - 78} fill="#b0904a" />
      <rect x={0} y={78} width={W} height={3} fill="#c2a25a" />
      <rect x={0} y={108} width={W} height={12} fill="#a2843f" />
      <Sprite rows={GROUND_SPECKS} palette={{ x: "#977a38", y: "#cdb06a" }} x={0} y={78} />
      {/* path from the cottage door to the stall */}
      <rect x={22} y={96} width={8} height={4} fill="#d6b27a" />
      <rect x={18} y={99} width={W - 18} height={8} fill="#d9b67e" />
      <rect x={18} y={99} width={W - 18} height={1} fill="#c39a60" />
      <rect x={18} y={106} width={W - 18} height={1} fill="#a98450" />
      {[30, 47, 61, 88, 104, 123, 139, 166, 181, 203, 224].map((x, i) => (
        <rect key={x} x={x} y={101 + (i % 3)} width={2} height={1} fill="#c7a068" />
      ))}
    </g>
  );
}

/* ---------- Cottage ---------- */

function Cottage() {
  const roof: React.ReactElement[] = [];
  for (let r = 0; r < 20; r++) {
    const half = 3 + Math.floor(r * 1.15);
    const x = 28 - half;
    roof.push(<rect key={`r${r}`} x={x - 1} y={50 + r} width={half * 2 + 2} height={1} fill={P.ink} />);
    roof.push(<rect key={`f${r}`} x={x} y={50 + r} width={half * 2} height={1} fill={r % 3 === 2 ? "#7a2f1c" : "#a4482a"} />);
    if (r % 3 === 1) {
      for (let k = x + (r % 2) * 2; k < x + half * 2; k += 4) roof.push(<rect key={`s${r}-${k}`} x={k} y={50 + r} width={1} height={1} fill="#c25a34" />);
    }
  }
  return (
    <g>
      {/* chimney */}
      <rect x={37} y={48} width={7} height={14} fill={P.ink} />
      <rect x={38} y={49} width={5} height={13} fill="#8a6a5a" />
      <rect x={38} y={52} width={5} height={1} fill="#6a4e44" />
      <rect x={38} y={56} width={5} height={1} fill="#6a4e44" />
      <rect x={36} y={47} width={9} height={2} fill={P.ink} />
      <g className="smoke">
        {[0, 1, 2].map((i) => (
          <rect key={i} className={`puff puff--${i}`} x={39} y={42} width={3} height={3} fill="#e8e0dc" opacity={0.85} />
        ))}
      </g>
      {roof}
      {/* walls */}
      <rect x={7} y={70} width={42} height={27} fill={P.ink} />
      <rect x={8} y={70} width={40} height={26} fill="#ead6a8" />
      <rect x={8} y={70} width={40} height={2} fill="#c9a874" />
      <rect x={8} y={83} width={40} height={1} fill={P.woodDark} />
      {[8, 27, 47].map((x) => (
        <rect key={x} x={x} y={70} width={1} height={26} fill={P.woodDark} />
      ))}
      <rect x={8} y={94} width={40} height={2} fill="#8a7050" />
      {/* door */}
      <rect x={21} y={82} width={11} height={14} fill={P.ink} />
      <rect x={22} y={83} width={9} height={13} fill={P.wood} />
      <rect x={22} y={83} width={9} height={1} fill={P.woodLight} />
      <rect x={26} y={84} width={1} height={12} fill={P.woodDark} />
      <rect x={29} y={89} width={1} height={1} fill={P.gold} />
      {/* windows */}
      {[11, 36].map((x) => (
        <g key={x}>
          <rect x={x} y={74} width={9} height={8} fill={P.ink} />
          <rect className="window" x={x + 1} y={75} width={7} height={6} fill="#9cc0d8" />
          <rect x={x + 4} y={75} width={1} height={6} fill={P.ink} />
          <rect x={x + 1} y={77} width={7} height={1} fill={P.ink} />
          <rect x={x + 1} y={75} width={1} height={1} fill="#e6f2f8" />
          <rect x={x - 1} y={82} width={11} height={2} fill={P.woodDark} />
          <Sprite x={x} y={80} palette={{ r: "#d8505a", y: "#f2bf3a", g: "#5d8a3a" }} rows={[".r.y.r.y.", "ggggggggg"]} />
        </g>
      ))}
    </g>
  );
}

/* ---------- Big tree (right) ---------- */

const FOLIAGE = (() => {
  const w = 46;
  const h = 40;
  const g = grid(w, h);
  const r = rand(99);
  const blobs = [
    [23, 18, 16],
    [12, 22, 11],
    [34, 22, 11],
    [22, 10, 11],
    [16, 28, 8],
    [31, 29, 8],
  ];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let inside = false;
      let shade = 0;
      for (const [cx, cy, rad] of blobs) {
        const d = Math.hypot(x - cx!, (y - cy!) * 1.1);
        if (d <= rad! - (r() < 0.25 ? 1 : 0)) {
          inside = true;
          shade = Math.max(shade, (x - cx! + (y - cy!) * 1.2) / rad!);
        }
      }
      if (!inside) continue;
      const v = r();
      g[y]![x] = shade > 0.55 ? "d" : shade < -0.6 ? "l" : v < 0.12 ? "r" : v < 0.22 ? "h" : "o";
    }
  // outline
  const out = g.map((row) => [...row]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (g[y]![x] !== ".") continue;
      const n = [g[y - 1]?.[x], g[y + 1]?.[x], g[y]?.[x - 1], g[y]?.[x + 1]].some((c) => c && c !== ".");
      if (n) out[y]![x] = "k";
    }
  return out.map((row) => row.join(""));
})();

function BigTree() {
  return (
    <g>
      <rect x={213} y={66} width={7} height={38} fill={P.ink} />
      <rect x={214} y={66} width={5} height={38} fill={P.woodDark} />
      <rect x={215} y={66} width={1} height={38} fill={P.wood} />
      <Sprite x={208} y={92} palette={{ k: P.ink, w: P.woodDark }} rows={["kkkkkk.......", "kwwwwkk..kkkk", ".kkkwwwkkwwwk", "....kkkkkkkk."]} />
      <rect x={210} y={78} width={4} height={1} fill={P.woodDark} />
      <rect x={220} y={74} width={5} height={1} fill={P.woodDark} />
      <Sprite x={194} y={36} rows={FOLIAGE} palette={{ k: "#5a2216", o: "#d0702c", h: "#f0b040", r: "#b8452a", d: "#8e3420", l: "#f6c860" }} />
      <rect x={202} y={104} width={30} height={1} fill="#8a7436" />
    </g>
  );
}

/* ---------- Stall ---------- */

function Stall() {
  const x0 = 150;
  const stripes = Array.from({ length: 12 }, (_, i) => i);
  return (
    <g>
      <rect x={x0 + 3} y={70} width={3} height={36} fill={P.woodDark} />
      <rect x={x0 + 40} y={70} width={3} height={36} fill={P.woodDark} />
      <rect x={x0 + 6} y={74} width={34} height={20} fill="#e9d3a4" />
      <rect x={x0 + 6} y={74} width={34} height={1} fill="#cdb27c" />
      {[x0 + 14, x0 + 24, x0 + 32].map((x) => (
        <rect key={x} x={x} y={75} width={1} height={18} fill="#dcc394" />
      ))}
      {/* awning */}
      <rect x={x0} y={62} width={47} height={1} fill={P.ink} />
      {stripes.map((i) => (
        <rect key={i} x={x0 + 1 + i * 4} y={63} width={4} height={8} fill={i % 2 ? "#f4e6c4" : "#b8452a"} />
      ))}
      <rect x={x0} y={63} width={1} height={8} fill={P.ink} />
      <rect x={x0 + 46} y={63} width={1} height={8} fill={P.ink} />
      {stripes.map((i) => (
        <rect key={`s${i}`} x={x0 + 2 + i * 4} y={71} width={2} height={1} fill={i % 2 ? "#f4e6c4" : "#b8452a"} />
      ))}
      <rect x={x0 + 1} y={70} width={45} height={1} fill="rgba(42,26,16,0.25)" />
      {/* hanging sign with a gold bar */}
      <rect x={x0 + 22} y={72} width={1} height={3} fill={P.ink} />
      <rect x={x0 + 31} y={72} width={1} height={3} fill={P.ink} />
      <rect x={x0 + 18} y={75} width={18} height={10} fill={P.ink} />
      <rect x={x0 + 19} y={76} width={16} height={8} fill={P.woodLight} />
      <rect x={x0 + 19} y={83} width={16} height={1} fill={P.wood} />
      <Sprite x={x0 + 22} y={78} palette={{ k: P.goldDark, y: P.gold, l: P.goldLight }} rows={["..kkkkkk..", ".kllyyyyk.", "kyyyyyyyyk", "kkkkkkkkkk"]} />
      {/* goods */}
      {[x0 + 8, x0 + 17, x0 + 26, x0 + 34].map((x, i) => (
        <Sprite key={x} x={x} y={i % 2 ? 90 : 89} palette={{ k: P.goldDark, y: P.gold, l: P.goldLight }} rows={i % 2 ? [".kkkk.", "klyyyk", "kkkkkk"] : [".kk.", "klyk", "kyyk", ".kk."]} />
      ))}
      {/* counter */}
      <rect x={x0 + 2} y={93} width={42} height={14} fill={P.ink} />
      <rect x={x0 + 3} y={94} width={40} height={2} fill={P.woodLight} />
      <rect x={x0 + 3} y={96} width={40} height={10} fill={P.wood} />
      {[x0 + 13, x0 + 23, x0 + 33].map((x) => (
        <rect key={x} x={x} y={96} width={1} height={10} fill={P.woodDark} />
      ))}
      <rect x={x0 + 3} y={103} width={40} height={1} fill={P.woodDark} />
      {/* lantern */}
      <rect x={x0 + 9} y={72} width={1} height={2} fill={P.ink} />
      <rect x={x0 + 8} y={74} width={3} height={5} fill={P.ink} />
      <rect x={x0 + 9} y={75} width={1} height={3} fill="#f6c050" />
    </g>
  );
}

/* ---------- Limit lanterns ---------- */

function Posts({ lit }: { lit: number }) {
  const xs = Array.from({ length: POSTS }, (_, i) => POST_X0 + i * POST_GAP);
  return (
    <g>
      {/* rope between posts */}
      {xs.slice(0, -1).map((x, i) => (
        <g key={`r${i}`} fill={P.woodDark}>
          <rect x={x + 2} y={90} width={1} height={1} />
          <rect x={x + 3} y={91} width={2} height={1} />
        </g>
      ))}
      {xs.map((x, i) => {
        const on = i < lit;
        return (
          <g key={i} className={on ? "post post--lit" : "post"}>
            <rect x={x} y={88} width={2} height={11} fill={P.ink} />
            <rect x={x} y={88} width={1} height={11} fill={P.wood} />
            <rect x={x - 1} y={82} width={4} height={6} fill={P.ink} />
            <rect x={x} y={81} width={2} height={1} fill={P.ink} />
            <rect x={x} y={83} width={2} height={4} fill={on ? "#ffd65a" : "#8a7a6a"} />
            {!on && <rect x={x} y={83} width={1} height={1} fill="#b8a894" />}
            {on && <rect className="flicker" x={x} y={84} width={1} height={2} fill="#fff6c4" />}
            <rect x={x - 1} y={98} width={4} height={1} fill="#8a7436" />
          </g>
        );
      })}
    </g>
  );
}

function SignPosts() {
  return (
    <g>
      <rect x={107} y={78} width={2} height={21} fill={P.ink} />
      <rect x={143} y={78} width={2} height={21} fill={P.ink} />
      <rect x={107} y={78} width={1} height={21} fill={P.woodDark} />
      <rect x={143} y={78} width={1} height={21} fill={P.woodDark} />
    </g>
  );
}

/* ---------- Props ---------- */

function Props() {
  const pumpkin = { k: "#6e2a18", o: "#d8692a", l: "#f09a48", s: "#3d6b4a" };
  const prows = ["...s...", ".kksKk.", "kololok", "koolook", ".kkkkk."].map((r) => r.replace("K", "k"));
  return (
    <g>
      <Sprite x={144} y={101} palette={pumpkin} rows={prows} />
      <Sprite x={198} y={100} palette={pumpkin} rows={prows} />
      <Sprite x={6} y={92} palette={pumpkin} rows={prows} />
      {/* hay bale */}
      <Sprite
        x={196}
        y={93}
        palette={{ k: "#6a4a1a", y: "#e0b850", d: "#b88a2c" }}
        rows={["kkkkkkkk", "kyydyydk", "kydyyyyk", "kyyydydk", "kkkkkkkk"]}
      />
      {/* flowers and stones */}
      {[
        [40, 112, "#f2d6e8"],
        [96, 114, "#ffffff"],
        [128, 111, "#f2d6e8"],
        [176, 113, "#ffffff"],
        [228, 110, "#f2d6e8"],
        [12, 108, "#ffffff"],
      ].map(([x, y, c]) => (
        <Sprite key={`${x}`} x={x as number} y={y as number} palette={{ f: c as string, c: "#f2bf3a" }} rows={[".f.", "fcf", ".f."]} />
      ))}
      {[
        [70, 109],
        [118, 115],
        [214, 114],
      ].map(([x, y]) => (
        <Sprite key={`st${x}`} x={x!} y={y!} palette={{ k: "#6a5a4a", s: "#a89a88", l: "#c8bca8" }} rows={[".ll.", "ksss", ".kk."]} />
      ))}
    </g>
  );
}

const TUFTS = [
  [4, 86], [16, 114], [34, 104], [52, 110], [64, 116], [84, 112], [100, 108], [112, 116], [134, 110], [158, 114], [172, 109], [188, 116], [206, 110], [234, 104], [236, 92], [88, 82], [126, 84],
];

function Tufts() {
  return (
    <g>
      {TUFTS.map(([x, y], i) => (
        <g key={i} className={`tuft tuft--${i % 3}`}>
          <Sprite x={x!} y={y!} palette={{ t: "#7d6a2e", l: "#9c8a3e" }} rows={["l.t.l", ".ltl.", "..t.."]} />
        </g>
      ))}
    </g>
  );
}

/* ---------- Chest ---------- */

function Chest({ level }: { level: number }) {
  const x0 = 54;
  const y0 = 88;
  const pile: React.ReactElement[] = [];
  for (let j = 0; j < level; j++) {
    const w = 16 - j * 3;
    const x = x0 + 1 + Math.floor((j * 3) / 2);
    const y = y0 + 2 - j;
    pile.push(<rect key={`p${j}`} x={x} y={y} width={w} height={1} fill={j % 2 ? P.goldDark : P.gold} />);
    for (let k = 1 + (j % 3); k < w - 1; k += 4) pile.push(<rect key={`h${j}-${k}`} x={x + k} y={y} width={1} height={1} fill={P.goldLight} />);
  }
  return (
    <g>
      {/* open lid, behind */}
      <rect x={x0} y={y0 - 8} width={18} height={9} fill={P.ink} />
      <rect x={x0 + 1} y={y0 - 7} width={16} height={7} fill={P.woodDark} />
      <rect x={x0 + 1} y={y0 - 7} width={16} height={1} fill={P.wood} />
      <rect x={x0 + 3} y={y0 - 7} width={1} height={7} fill={P.iron} />
      <rect x={x0 + 14} y={y0 - 7} width={1} height={7} fill={P.iron} />
      {/* inside */}
      <rect x={x0} y={y0} width={18} height={4} fill={P.ink} />
      <rect x={x0 + 1} y={y0 + 1} width={16} height={2} fill="#3b2415" />
      {pile}
      {level >= 5 && (
        <>
          <Sprite x={x0 + 6} y={y0 - 4} palette={{ k: P.goldDark, y: P.gold, l: P.goldLight }} rows={[".kkkk.", "klllyk", "kkkkkk"]} />
          <Sprite x={x0 - 4} y={y0 + 11} palette={coinPalette} rows={COIN} />
          <Sprite x={x0 + 19} y={y0 + 12} palette={coinPalette} rows={[".kk.", "kyyk", ".kk."]} />
        </>
      )}
      {/* front */}
      <rect x={x0} y={y0 + 3} width={18} height={11} fill={P.ink} />
      <rect x={x0 + 1} y={y0 + 4} width={16} height={9} fill={P.wood} />
      <rect x={x0 + 1} y={y0 + 4} width={16} height={1} fill={P.woodLight} />
      <rect x={x0 + 1} y={y0 + 12} width={16} height={1} fill={P.woodDark} />
      <rect x={x0 + 3} y={y0 + 4} width={1} height={9} fill={P.iron} />
      <rect x={x0 + 14} y={y0 + 4} width={1} height={9} fill={P.iron} />
      <rect x={x0 + 8} y={y0 + 5} width={2} height={3} fill={P.gold} />
      <rect x={x0 + 8} y={y0 + 7} width={2} height={1} fill={P.goldDark} />
      <rect x={x0 - 1} y={y0 + 14} width={20} height={1} fill="#8a7436" />
    </g>
  );
}

/* ---------- Helper ---------- */

function IdleHelper({ still }: { still: boolean }) {
  return (
    <g className={still ? "" : "breathe"}>
      <g className={still ? "" : "eyes-open"}>
        <Sprite rows={HELPER_STAND} palette={helperPalette} x={HOME_X} y={HELPER_Y} />
      </g>
      {!still && (
        <g className="eyes-shut">
          <Sprite rows={HELPER_BLINK} palette={helperPalette} x={HOME_X} y={HELPER_Y} />
        </g>
      )}
    </g>
  );
}

function WalkingHelper() {
  return (
    <g className="trip" style={{ "--trip-dx": `${STALL_X - HOME_X}px` } as React.CSSProperties}>
      <g className="trip__face">
        <g className="trip__walking">
          <g className="walk walk--a">
            <Sprite rows={HELPER_WALK_A} palette={helperPalette} x={HOME_X} y={HELPER_Y} />
          </g>
          <g className="walk walk--b">
            <Sprite rows={HELPER_WALK_B} palette={helperPalette} x={HOME_X} y={HELPER_Y - 1} />
          </g>
          <g className="walk walk--c">
            <Sprite rows={HELPER_WALK_C} palette={helperPalette} x={HOME_X} y={HELPER_Y} />
          </g>
        </g>
        <g className="trip__standing">
          <Sprite rows={HELPER_STAND} palette={helperPalette} x={HOME_X} y={HELPER_Y} />
        </g>
        <g className="trip__coin">
          <Sprite rows={COIN} palette={coinPalette} x={HOME_X + 9} y={HELPER_Y + 9} />
        </g>
      </g>
    </g>
  );
}

/** When the helper is back, a coin hops into the chest with a sparkle. */
function CoinPop() {
  const spark = { l: "#fff6c4", y: P.gold };
  return (
    <g className="coinpop">
      <g className="coinpop__coin">
        <Sprite rows={COIN} palette={coinPalette} x={61} y={78} />
      </g>
      <g className="coinpop__spark">
        <Sprite x={54} y={74} palette={spark} rows={[".l.", "lyl", ".l."]} />
        <Sprite x={68} y={72} palette={spark} rows={[".l.", "lyl", ".l."]} />
        <Sprite x={62} y={70} palette={spark} rows={["l"]} />
        <Sprite x={74} y={80} palette={spark} rows={["l"]} />
        <Sprite x={50} y={82} palette={spark} rows={["l"]} />
      </g>
    </g>
  );
}

function Campfire() {
  return (
    <g>
      <Sprite rows={LOG} palette={{ k: P.ink, b: P.wood, n: P.woodLight, B: P.woodDark }} x={74} y={97} />
      <Sprite rows={HELPER_SIT} palette={helperPalette} x={76} y={88} />
      {/* fire */}
      <Sprite x={92} y={101} palette={{ s: "#8a8078", S: "#5a524c", w: P.woodDark }} rows={[".swwwws.", "SsSsSsSS"]} />
      <g className="flame flame--a">
        <Sprite x={93} y={94} palette={{ r: "#d8452a", o: "#f08a2a", y: "#ffd65a" }} rows={["...r..", "..ro..", ".royr.", "royyor", ".ryyr.", "..rr.."]} />
      </g>
      <g className="flame flame--b">
        <Sprite x={93} y={94} palette={{ r: "#d8452a", o: "#f08a2a", y: "#ffd65a" }} rows={["..r...", "..or..", ".royo.", "royyyr", ".ryyor", "..rr.."]} />
      </g>
      <rect className="ember" x={96} y={92} width={1} height={1} fill="#ffb04a" />
    </g>
  );
}

function SleepingZ() {
  return (
    <>
      <g className="zzz zzz--a">
        <Sprite rows={Z} palette={{ k: "#fff4d8" }} x={86} y={82} />
      </g>
      <g className="zzz zzz--b">
        <Sprite rows={Z} palette={{ k: "#fff4d8" }} x={90} y={76} />
      </g>
    </>
  );
}

/* ---------- Light ---------- */

const OVERLAY: Record<Phase, { fill: string; opacity: number } | null> = {
  dawn: { fill: "#3a2a5a", opacity: 0.12 },
  day: null,
  dusk: { fill: "#4a1f3a", opacity: 0.2 },
  night: { fill: "#0b1030", opacity: 0.42 },
};

function Overlay({ phase }: { phase: Phase }) {
  const o = OVERLAY[phase];
  if (!o) return null;
  return <rect x={0} y={44} width={W} height={H - 44} fill={o.fill} opacity={o.opacity} />;
}

function Glows({ dark, lit, resting }: { dark: boolean; lit: number; resting: boolean }) {
  return (
    <g>
      {dark && (
        <>
          {[12, 37].map((x) => (
            <g key={x}>
              <rect x={x - 2} y={73} width={11} height={10} fill="#ffd36a" opacity={0.22} />
              <rect x={x} y={75} width={7} height={6} fill="#ffd36a" />
              <rect x={x + 3} y={75} width={1} height={6} fill="#6a3a1a" />
              <rect x={x} y={77} width={7} height={1} fill="#6a3a1a" />
            </g>
          ))}
          <rect x={155} y={71} width={9} height={11} fill="#ffd36a" opacity={0.25} />
          <rect x={159} y={75} width={1} height={3} fill="#fff1a8" />
        </>
      )}
      {Array.from({ length: lit }, (_, i) => {
        const x = POST_X0 + i * POST_GAP;
        return (
          <g key={i}>
            <rect className="halo" x={x - 2} y={81} width={6} height={8} fill="#ffd65a" opacity={dark ? 0.35 : 0.18} />
            <rect x={x} y={83} width={2} height={4} fill="#ffd65a" />
            <rect className="flicker" x={x} y={84} width={1} height={2} fill="#fff6c4" />
          </g>
        );
      })}
      {resting && (
        <g className="halo">
          <rect x={86} y={92} width={18} height={14} fill="#ffa040" opacity={dark ? 0.22 : 0.1} />
          <rect x={89} y={89} width={12} height={18} fill="#ffa040" opacity={dark ? 0.16 : 0.08} />
        </g>
      )}
    </g>
  );
}

/* ---------- Leaves ---------- */

const LEAF_COLORS = ["#d0702c", "#f0b040", "#b8452a"];
const LEAVES = [
  [206, 50, 0],
  [222, 56, 1],
  [214, 64, 2],
  [234, 46, 0],
  [198, 60, 1],
  [120, 66, 2],
  [60, 64, 1],
  [170, 60, 0],
];

/** Leaves drifting down on the wind. CSS only; off under reduced motion. */
export function FallingLeaves() {
  return (
    <g>
      {LEAVES.map(([x, y, c], i) => (
        <g key={i} className={`leaf leaf--${i}`}>
          <Sprite x={x!} y={y!} palette={{ l: LEAF_COLORS[c!]!, d: "#6e2a18" }} rows={["ll.", "lld", ".d."]} />
        </g>
      ))}
    </g>
  );
}
