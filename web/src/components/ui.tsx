"use client";

import { useState } from "react";
import { encode } from "uqr";
import { PasskeyError, txUrl, type TxHash, type Wallet } from "@/lib/autumn";
import { errorText } from "@/lib/useAutumn";
import { Icon, type IconName } from "./icons";

/**
 * A parchment panel. Its title hangs on a small wooden signboard with an icon.
 */
export function Panel({
  title,
  icon,
  children,
  className = "",
  tone = "paper",
  as: Tag = "section",
  headingLevel = 2,
}: {
  title?: string;
  icon?: IconName;
  children: React.ReactNode;
  className?: string;
  tone?: "paper" | "alert" | "stopped";
  as?: "section" | "div";
  headingLevel?: 2 | 3;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <Tag className={`frame frame--${tone} ${title ? "frame--titled" : ""} ${className}`}>
      {title && (
        <H className="plank">
          {icon && <Icon name={icon} />}
          <span>{title}</span>
        </H>
      )}
      {children}
    </Tag>
  );
}

/** A screen's heading, on the page backdrop, with an optional Back button. */
export function ScreenHead({ title, onBack, backDisabled }: { title: string; onBack?: (() => void) | undefined; backDisabled?: boolean }) {
  return (
    <div className="screen-head">
      <h1>{title}</h1>
      {onBack && (
        <Button variant="plain" className="btn--small" onClick={onBack} disabled={backDisabled}>
          Back
        </Button>
      )}
    </div>
  );
}

/** A label with its pixel icon, for fact lists and choices. */
export function Label({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <span className="label">
      <Icon name={icon} />
      <span>{children}</span>
    </span>
  );
}

/** The ribbon banner that carries the main status. */
export function Banner({ tone, children, level = 2 }: { tone: "running" | "busy" | "rest"; children: React.ReactNode; level?: 1 | 2 }) {
  const H = level === 1 ? "h1" : "h2";
  return (
    <div className={`banner banner--${tone}`}>
      <H className="banner__text">{children}</H>
    </div>
  );
}

const TRAIL = ["Create wallet", "Add money", "Choose a plan", "Gold arrives"] as const;

/** Onboarding progress, drawn as a little path with waypoints. `at` is the current step (0-based). */
export function Trail({ at }: { at: number }) {
  return (
    <ol className="trail" aria-label="Setup steps">
      {TRAIL.map((t, i) => (
        <li key={t} className={`trail__stop ${i < at ? "is-done" : i === at ? "is-here" : ""}`} aria-current={i === at ? "step" : undefined}>
          <span className="trail__dot" aria-hidden="true" />
          <span className="trail__name">
            {t}
            {i < at && <span className="sr-only"> (done)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "danger" | "plain";
  block?: boolean;
};

export function Button({ variant = "primary", block, className = "", ...rest }: BtnProps) {
  return <button type="button" className={`btn btn--${variant} ${block ? "btn--block" : ""} ${className}`} {...rest} />;
}

export function CopyButton({ text, label = "Copy", what = "address" }: { text: string; label?: string; what?: string }) {
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
      <Button variant="plain" onClick={copy} className="btn--small" aria-label={`Copy ${what}`}>
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
      </Button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? `Copied the ${what}` : state === "failed" ? `Could not copy. Select the ${what} instead.` : ""}
      </span>
    </>
  );
}

/**
 * A link to a transaction on Celoscan. `label` is its accessible name: each
 * link on a page must say which transaction it opens ("View the purchase of
 * 0.04 g on Celoscan"), not only "View on Celoscan".
 */
export function TxLink({ hash, children = "View on Celoscan", label }: { hash: TxHash; children?: React.ReactNode; label?: string }) {
  return <ExtLink href={txUrl(hash)} label={label}>{children}</ExtLink>;
}

/** An external link that opens in a new tab, with a tap target of at least 44 px. */
export function ExtLink({ href, children, label }: { href: string; children: React.ReactNode; label?: string | undefined }) {
  return (
    <a className="txlink" href={href} target="_blank" rel="noopener noreferrer" {...(label ? { "aria-label": `${label} (opens in a new tab)` } : {})}>
      {children}
      {!label && <span className="sr-only"> (opens in a new tab)</span>}
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

/** A small lantern whose flame flickers: the busy indicator. */
export function Spinner() {
  return (
    <svg className="spinner" viewBox="0 0 7 11" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <rect x="2" y="0" width="3" height="1" fill="#2a1a10" />
      <rect x="1" y="1" width="1" height="1" fill="#2a1a10" />
      <rect x="5" y="1" width="1" height="1" fill="#2a1a10" />
      <rect x="0" y="2" width="7" height="9" fill="#2a1a10" />
      <rect x="1" y="3" width="5" height="1" fill="#9a6034" />
      <rect x="1" y="9" width="5" height="1" fill="#9a6034" />
      <rect x="1" y="4" width="5" height="5" fill="#f2a83a" />
      <g className="spinner__flame">
        <rect x="3" y="4" width="1" height="1" fill="#fff4c4" />
        <rect x="2" y="5" width="3" height="3" fill="#ffe27a" />
        <rect x="3" y="6" width="1" height="1" fill="#fffbe8" />
      </g>
    </svg>
  );
}

/**
 * A failure from an action. A failed passkey step gets a clear panel with its
 * plain message and a Retry button; any other error is a short red line.
 */
export function FailureNotice({
  error,
  onRetry,
  onDeviceFallback,
  prefix = "",
}: {
  error: unknown;
  onRetry?: () => void;
  /** Offered after a cancelled or unsupported passkey creation: create the passkey with this device's screen lock. */
  onDeviceFallback?: () => void;
  prefix?: string;
}) {
  if (error === null || error === undefined) return null;
  if (error instanceof PasskeyError) {
    const fallback = onDeviceFallback && error.step === "create" && (error.reason === "cancelled" || error.reason === "unsupported");
    return (
      <div className="failure" role="alert">
        <p className="failure__title">
          <Icon name="passkey" /> The passkey step did not finish
        </p>
        <p>{error.message}</p>
        {error.reason === "unsupported" && <p className="failure__hint">On Android, open this page in Chrome.</p>}
        {onRetry && (
          <Button variant="plain" className="btn--small" onClick={onRetry}>
            Retry
          </Button>
        )}
        {fallback && (
          <>
            <Button variant="plain" className="btn--small" onClick={onDeviceFallback}>
              Use this phone&apos;s screen lock instead
            </Button>
            <p className="small">If your phone only offered another device or a USB key, choose this. The passkey will live on this device only.</p>
          </>
        )}
      </div>
    );
  }
  return (
    <p className="error-text" role="alert">
      {prefix}
      {errorText(error)}
    </p>
  );
}

/** True when the wallet's passkey may be device-bound, so the backup code matters. */
export const isDeviceBound = (w: Wallet | null | undefined) => !!w && w.passkey.discoverable !== true;

/** The reminder chip for a device-bound passkey, with a way to see the backup code again. */
export function BackupChip({ onBackupCode }: { onBackupCode: () => void }) {
  return (
    <p className="chip">
      <Icon name="passkey" />
      <span>Passkey lives on this device only.</span>
      <button type="button" className="chip__btn" onClick={onBackupCode}>
        Backup code
      </button>
    </p>
  );
}
