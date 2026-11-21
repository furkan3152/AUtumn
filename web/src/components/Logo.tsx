import { compactMark, wordmark } from "./logoPixels";

/** Autumn logo. "AU" is drawn as gold: the chemical symbol for gold. */
export function Logo({ variant, scale = 4 }: { variant: "full" | "compact"; scale?: number }) {
  const m = variant === "full" ? wordmark() : compactMark();
  return (
    <svg
      className={`logo logo--${variant}`}
      viewBox={`0 0 ${m.width} ${m.height}`}
      width={m.width * scale}
      height={m.height * scale}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Autumn"
    >
      {m.px.map((p, i) => (
        <rect key={i} x={p.x} y={p.y} width={1} height={1} fill={p.c} />
      ))}
    </svg>
  );
}
