"use client";

import { useState } from "react";
import { encode } from "uqr";
import { txUrl, type TxHash } from "@/lib/autumn";

export function Panel({
  title,
  children,
  className = "",
  tone = "paper",
  as: Tag = "section",
  headingLevel = 2,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  tone?: "paper" | "alert" | "stopped";
  as?: "section" | "div";
  headingLevel?: 2 | 3;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <Tag className={`frame frame--${tone} ${className}`}>
      {title && <H className="frame__title">{title}</H>}
      {children}
    </Tag>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "danger" | "plain";
  block?: boolean;
};

export function Button({ variant = "primary", block, className = "", ...rest }: BtnProps) {
  return <button type="button" className={`btn btn--${variant} ${block ? "btn--block" : ""} ${className}`} {...rest} />;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <>
      <Button variant="plain" onClick={copy} className="btn--small">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
      </Button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Address copied" : state === "failed" ? "Could not copy. Select the address instead." : ""}
      </span>
    </>
  );
}

export function TxLink({ hash, children = "View on Celoscan" }: { hash: TxHash; children?: React.ReactNode }) {
  return (
    <a className="txlink" href={txUrl(hash)} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** QR code drawn as crisp pixels. */
export function Qr({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: "M", border: 2 });
  const rects: React.ReactElement[] = [];
  data.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= size; x++) {
      const on = x < size && row[x];
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        rects.push(<rect key={`${x}-${y}`} x={start} y={y} width={x - start} height={1} />);
        start = -1;
      }
    }
  });
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label={label}>
      <rect width={size} height={size} fill="#fff" />
      <g fill="#2a1c12">{rects}</g>
    </svg>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
