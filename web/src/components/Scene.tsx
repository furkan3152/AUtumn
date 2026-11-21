"use client";

import { useEffect, useRef, useState } from "react";
import {
  COIN,
  HELPER_SIT,
  HELPER_STAND,
  HELPER_WALK_A,
  HELPER_WALK_B,
  P,
  Sprite,
  Z,
  coinPalette,
  helperPalette,
} from "./pixel";

const W = 160;
const H = 84;
const HOME_X = 44;
const STALL_X = 104;
const HELPER_Y = 52;
export const TRIP_MS = 6000;
const POSTS = 10;

export type SceneMode = "intro" | "active" | "stopping" | "stopped" | "expired";

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

function isNight(d = new Date()) {
  const h = d.getHours();
  return h < 6 || h >= 19;
}

export function Scene({ mode, chestFill, limitUsed, purchaseKey, label, signText }: SceneProps) {
  const reduced = usePrefersReducedMotion();
  const [night, setNight] = useState(false);
  useEffect(() => {
    setNight(isNight());
    const t = setInterval(() => setNight(isNight()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Walk to the stall when a new purchase lands. Chest and fence update when the helper is back.
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
  const usedPosts = Math.min(POSTS, Math.round(shownUsed * POSTS));
  const resting = mode === "stopped" || mode === "expired";

  return (
    <div className={`scene ${reduced ? "scene--still" : ""}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label={label}
        className="scene__svg"
      >
        <Sky night={night} />
        <Ground />
        {mode !== "intro" && <Fence used={usedPosts} />}
        <Tree />
        <Stall night={night} />
        <Pumpkins />
        <Chest level={level} sparkle={trip?.id} />
        {resting ? (
          <SleepingHelper />
        ) : trip ? (
          <WalkingHelper key={trip.id} />
        ) : (
          <g className={mode === "stopping" ? "" : "bob"}>
            <Sprite rows={HELPER_STAND} palette={helperPalette} x={HOME_X} y={HELPER_Y} />
          </g>
        )}
        {resting && <SignPosts />}
        <FallingLeaves />
      </svg>
      {resting && signText && (
        <div className="scene__sign" aria-hidden="true">
          {signText}
        </div>
      )}
    </div>
  );
}

function Sky({ night }: { night: boolean }) {
  const bands = night ? ["#1f2a4d", "#29375f", "#34466f", "#41557c"] : ["#7d94c4", "#a3a6cf", "#d6b2b4", "#f0c99a"];
  return (
    <g>
      {bands.map((c, i) => (
        <rect key={c} x={0} y={i * 12} width={W} height={i === 3 ? 14 : 12} fill={c} />
      ))}
      {night ? (
        <>
          {[
            [12, 6],
            [30, 14],
            [52, 4],
            [78, 10],
            [96, 3],
            [108, 16],
            [150, 20],
          ].map(([x, y]) => (
            <rect key={`${x}`} className="twinkle" x={x} y={y} width={1} height={1} fill="#fff6c8" />
          ))}
          <Sprite
            x={134}
            y={5}
            palette={{ m: "#f4ecc8", d: "#d8cc9a" }}
            rows={["..mmmm..", ".mmmmdm.", "mmmmmmmm", "mmdmmmmm", "mmmmmmdm", "mmmmmmmm", ".mmdmmm.", "..mmmm.."]}
          />
        </>
      ) : (
        <>
          <Sprite
            x={98}
            y={27}
            palette={{ s: "#e9823a", l: "#ffc56b" }}
            rows={["..ssss..", ".sllllls", "sllllllS", "slllllls", "slllllls", "slllllls", ".sllllls", "..ssss.."].map((r) =>
              r.replace("S", "s"),
            )}
          />
          <g className="cloud cloud--a">
            <Cloud x={20} y={8} />
          </g>
          <g className="cloud cloud--b">
            <Cloud x={84} y={16} />
          </g>
        </>
      )}
      {/* far hills */}
      <Sprite
        x={0}
        y={38}
        palette={{ h: night ? "#2a4636" : "#5f7a52" }}
        rows={[
          "..........hhhhhh..................................hhhhhhhh.....................................hhhhh...........................................",
          "......hhhhhhhhhhhhhh.....................hhhhhhhhhhhhhhhhhhhhhhh.......................hhhhhhhhhhhhhhhhhh...............................hhhhhhhh",
          "..hhhhhhhhhhhhhhhhhhhhhh..........hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh.............hhhhhhhhhhhhhhhhhhhhhhhhhhh.....................hhhhhhhhhhhhhhhhhhhh",
          "hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
        ]}
      />
      {night && <rect x={0} y={0} width={W} height={H} fill="#0b1030" opacity={0} />}
    </g>
  );
}

function Cloud({ x, y }: { x: number; y: number }) {
  return (
    <Sprite
      x={x}
      y={y}
      palette={{ w: "#f6e6e0", g: "#dcc3cc" }}
      rows={["....wwww......", "..wwwwwwww.ww.", ".wwwwwwwwwwwww", "gggggggggggggg"]}
    />
  );
}

function Ground() {
  const tufts = [
    [6, 60],
    [18, 74],
    [40, 79],
    [62, 72],
    [88, 78],
    [100, 56],
    [126, 76],
    [146, 70],
    [76, 56],
    [10, 80],
  ];
  return (
    <g>
      <rect x={0} y={42} width={W} height={H - 42} fill="#b39a4c" />
      <rect x={0} y={42} width={W} height={2} fill="#9c8540" />
      {/* path */}
      <rect x={20} y={64} width={140} height={6} fill="#d9b47c" />
      <rect x={20} y={64} width={140} height={1} fill="#c39a60" />
      <rect x={20} y={70} width={140} height={1} fill="#b58b52" />
      {tufts.map(([x, y]) => (
        <Sprite key={`${x}-${y}`} x={x} y={y} palette={{ t: "#7d6a2e" }} rows={["t.t", ".t."]} />
      ))}
      <Sprite x={70} y={76} palette={{ f: "#f2d6e8", c: "#f2bf3a" }} rows={[".f.", "fcf", ".f."]} />
      <Sprite x={112} y={80} palette={{ f: "#ffffff", c: "#f2bf3a" }} rows={[".f.", "fcf", ".f."]} />
    </g>
  );
}

function Fence({ used }: { used: number }) {
  const x0 = 54;
  return (
    <g>
      <rect x={x0 - 1} y={46} width={POSTS * 5 + 1} height={1} fill={P.woodDark} />
      <rect x={x0 - 1} y={50} width={POSTS * 5 + 1} height={1} fill={P.woodDark} />
      {Array.from({ length: POSTS }, (_, i) => {
        const isUsed = i < used;
        const x = x0 + i * 5;
        return (
          <g key={i}>
            <rect x={x} y={43} width={3} height={10} fill={P.ink} />
            <rect x={x} y={44} width={3} height={8} fill={isUsed ? P.gold : P.cream} />
            <rect x={x + 1} y={42} width={1} height={1} fill={P.ink} />
            <rect x={x + 2} y={44} width={1} height={8} fill={isUsed ? P.goldDark : "#d8c49a"} />
          </g>
        );
      })}
    </g>
  );
}

function Tree() {
  return (
    <g>
      <rect x={10} y={34} width={4} height={24} fill={P.woodDark} />
      <rect x={11} y={34} width={1} height={24} fill={P.wood} />
      <rect x={8} y={40} width={3} height={1} fill={P.woodDark} />
      <Sprite
        x={0}
        y={14}
        palette={{ d: "#8e3420", l: "#d0702c", h: "#f0b040", r: "#b8452a" }}
        rows={[
          "........dddddd..........",
          "......ddhhllllldd.......",
          "....ddlhhhllllllldd.....",
          "...dllhhllllrrlllllld...",
          "..dlllhllllrrrllhhllld..",
          ".dlllllllllllllhhhllllld",
          ".dllrrlllllllllllhlllld.",
          "dllrrrllllhhllllllllrrld",
          "dlllllllllhhhlllllllrrld",
          "dllllhllllllllllrlllllld",
          ".dlllhhlllrrllllllllhld.",
          ".ddllllllrrrlllllllllldd",
          "..dddlllllllllhllllldd..",
          "....dddllllllllllddd....",
          ".......ddddddddddd......",
        ]}
      />
      <rect x={6} y={58} width={12} height={1} fill="#8a7436" />
    </g>
  );
}

function Stall({ night }: { night: boolean }) {
  const x0 = 114;
  const stripes = Array.from({ length: 11 }, (_, i) => i);
  return (
    <g>
      {/* posts */}
      <rect x={x0 + 3} y={30} width={3} height={34} fill={P.woodDark} />
      <rect x={x0 + 36} y={30} width={3} height={34} fill={P.woodDark} />
      {/* back wall */}
      <rect x={x0 + 6} y={33} width={30} height={18} fill="#e9d3a4" />
      <rect x={x0 + 6} y={33} width={30} height={1} fill="#cdb27c" />
      {/* awning */}
      <rect x={x0} y={23} width={42} height={1} fill={P.ink} />
      {stripes.map((i) => (
        <rect key={i} x={x0 + 1 + i * 4} y={24} width={4} height={7} fill={i % 2 ? P.cream : P.red} />
      ))}
      <rect x={x0} y={24} width={1} height={7} fill={P.ink} />
      <rect x={x0 + 41} y={24} width={1} height={7} fill={P.ink} />
      {stripes.map((i) => (
        <rect key={`s${i}`} x={x0 + 2 + i * 4} y={31} width={2} height={1} fill={i % 2 ? P.cream : P.red} />
      ))}
      {/* hanging sign with a gold bar */}
      <rect x={x0 + 15} y={34} width={12} height={8} fill={P.woodDark} />
      <rect x={x0 + 16} y={35} width={10} height={6} fill={P.woodLight} />
      <Sprite x={x0 + 17} y={36} palette={{ k: P.goldDark, y: P.gold, l: P.goldLight }} rows={["..kkkk..", ".kyllyk.", "kyyyyyyk", "kkkkkkkk"]} />
      {/* goods: gold bars */}
      {[x0 + 9, x0 + 18, x0 + 27].map((x) => (
        <Sprite key={x} x={x} y={47} palette={{ k: P.goldDark, y: P.gold, l: P.goldLight }} rows={[".kkkk.", "kylyyk", "kkkkkk"]} />
      ))}
      {/* counter */}
      <rect x={x0 + 2} y={50} width={38} height={14} fill={P.ink} />
      <rect x={x0 + 3} y={51} width={36} height={2} fill={P.woodLight} />
      <rect x={x0 + 3} y={53} width={36} height={10} fill={P.wood} />
      {[x0 + 10, x0 + 21, x0 + 32].map((x) => (
        <rect key={x} x={x} y={53} width={1} height={10} fill={P.woodDark} />
      ))}
      {/* lantern */}
      <rect x={x0 + 7} y={34} width={3} height={4} fill={P.ink} />
      <rect x={x0 + 8} y={35} width={1} height={2} fill={night ? "#ffe066" : "#d8a640"} />
      {night && <rect x={x0 + 5} y={33} width={7} height={7} fill="#ffe066" opacity={0.25} />}
    </g>
  );
}

function Chest({ level, sparkle }: { level: number; sparkle?: number }) {
  const x0 = 26;
  const y0 = 54;
  const pile: React.ReactElement[] = [];
  for (let j = 0; j < level; j++) {
    const w = 14 - j * 2;
    const x = x0 + 1 + j;
    const y = y0 + 2 - j;
    pile.push(<rect key={`p${j}`} x={x} y={y} width={w} height={1} fill={j % 2 ? P.goldDark : P.gold} />);
    pile.push(<rect key={`h${j}`} x={x + 1 + ((j * 5) % Math.max(1, w - 2))} y={y} width={1} height={1} fill={P.goldLight} />);
  }
  return (
    <g>
      {/* open lid, behind */}
      <rect x={x0} y={y0 - 7} width={16} height={8} fill={P.ink} />
      <rect x={x0 + 1} y={y0 - 6} width={14} height={6} fill={P.woodDark} />
      <rect x={x0 + 1} y={y0 - 6} width={14} height={1} fill={P.wood} />
      <rect x={x0 + 3} y={y0 - 6} width={1} height={6} fill={P.iron} />
      <rect x={x0 + 12} y={y0 - 6} width={1} height={6} fill={P.iron} />
      {/* inside */}
      <rect x={x0} y={y0} width={16} height={4} fill={P.ink} />
      <rect x={x0 + 1} y={y0 + 1} width={14} height={2} fill="#3b2415" />
      {pile}
      {/* front */}
      <rect x={x0} y={y0 + 3} width={16} height={10} fill={P.ink} />
      <rect x={x0 + 1} y={y0 + 4} width={14} height={8} fill={P.wood} />
      <rect x={x0 + 1} y={y0 + 4} width={14} height={1} fill={P.woodLight} />
      <rect x={x0 + 3} y={y0 + 4} width={1} height={8} fill={P.iron} />
      <rect x={x0 + 12} y={y0 + 4} width={1} height={8} fill={P.iron} />
      <rect x={x0 + 7} y={y0 + 5} width={2} height={3} fill={P.gold} />
      <rect x={x0 + 7} y={y0 + 7} width={2} height={1} fill={P.goldDark} />
      <rect x={x0 - 1} y={y0 + 13} width={18} height={1} fill="#8a7436" />
      {sparkle && (
        <g className="sparkle" key={sparkle}>
          <Sprite x={x0 + 3} y={y0 - 10} palette={{ l: P.goldLight }} rows={[".l.", "lll", ".l."]} />
          <Sprite x={x0 + 10} y={y0 - 12} palette={{ l: P.goldLight }} rows={[".l.", "lll", ".l."]} />
        </g>
      )}
    </g>
  );
}

function WalkingHelper() {
  return (
    <g className="trip">
      <g className="trip__face">
        <g className="frame-a">
          <Sprite rows={HELPER_WALK_A} palette={helperPalette} x={HOME_X} y={HELPER_Y} />
        </g>
        <g className="frame-b">
          <Sprite rows={HELPER_WALK_B} palette={helperPalette} x={HOME_X} y={HELPER_Y} />
        </g>
      </g>
      <g className="trip__coin">
        <Sprite rows={COIN} palette={coinPalette} x={HOME_X - 3} y={HELPER_Y + 8} />
      </g>
      <style>{`.trip{--trip-dx:${STALL_X - HOME_X}px}`}</style>
    </g>
  );
}

function SleepingHelper() {
  return (
    <g>
      <Sprite rows={HELPER_SIT} palette={helperPalette} x={HOME_X} y={HELPER_Y + 3} />
      <g className="zzz zzz--a">
        <Sprite rows={Z} palette={{ k: "#fbefd2" }} x={HOME_X + 10} y={HELPER_Y - 2} />
      </g>
      <g className="zzz zzz--b">
        <Sprite rows={Z} palette={{ k: "#fbefd2" }} x={HOME_X + 14} y={HELPER_Y - 8} />
      </g>
    </g>
  );
}

function SignPosts() {
  return (
    <g>
      <rect x={70} y={38} width={2} height={24} fill={P.woodDark} />
      <rect x={90} y={38} width={2} height={24} fill={P.woodDark} />
    </g>
  );
}

const LEAF_COLORS = ["#d0702c", "#f0b040", "#b8452a"];

/** A few leaves drifting down from the tree. CSS only; off under reduced motion. */
export function FallingLeaves() {
  const leaves = [
    [4, 24, 0],
    [16, 22, 1],
    [10, 27, 2],
    [20, 25, 0],
  ];
  return (
    <g>
      {leaves.map(([x, y, c], i) => (
        <g key={i} className={`leaf leaf--${i}`}>
          <Sprite x={x} y={y} palette={{ l: LEAF_COLORS[c], d: "#6e2a18" }} rows={["ll.", "lld", ".d."]} />
        </g>
      ))}
    </g>
  );
}

function Pumpkins() {
  const pal = { k: "#6e2a18", o: "#d8692a", l: "#f09a48", s: "#3d6b4a" };
  const rows = ["...s..", ".kkskk", "kolool", "koolok", ".kkkk."];
  return (
    <g>
      <Sprite x={106} y={58} palette={pal} rows={rows} />
      <Sprite x={152} y={62} palette={pal} rows={rows} />
      <Sprite x={47} y={72} palette={{ s: "#3d6b4a", k: "#6e2a18", g: "#e8b13a" }} rows={["..s.", ".kk.", "kggk", ".kk."]} />
    </g>
  );
}
