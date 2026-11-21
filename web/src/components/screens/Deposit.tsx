"use client";

import { addressUrl, isFunded, type GramState } from "@/lib/gram";
import { celo, formatDateTime, usdt } from "@/lib/format";
import { Button, CopyButton, Panel, Qr, Spinner } from "../ui";

export function Deposit({
  state,
  onContinue,
  onBack,
}: {
  state: GramState;
  onContinue?: () => void;
  onBack?: () => void;
}) {
  const wallet = state.wallet!;
  const b = state.balances;
  const reg = state.registration;
  const needsFee = reg ? !reg.paid : true;
  const funded = isFunded(state);
  const groups = wallet.address.slice(2).match(/.{1,4}/g) ?? [];

  return (
    <div className="stack narrow">
      <div className="screen-head">
        <h1>Add money</h1>
        {onBack && (
          <Button variant="plain" className="btn--small" onClick={onBack}>
            Back
          </Button>
        )}
      </div>

      <Panel title="Your wallet address">
        <div className="deposit">
          <Qr value={wallet.address} label="QR code of your wallet address" />
          <div className="deposit__addr">
            <p className="addr" aria-label={`Address ${wallet.address}`}>
              <span>0x</span>
              {groups.map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </p>
            <div className="row">
              <CopyButton text={wallet.address} label="Copy address" />
              <a className="txlink" href={addressUrl(wallet.address)} target="_blank" rel="noopener noreferrer">
                View on Celoscan<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="What to send">
        <ul className="send-list">
          <li>
            <strong>USD₮</strong> on the Celo network. This is the money used to buy gold.
          </li>
          {needsFee && reg && (
            <li>
              <strong>
                About <span className="num">{celo(reg.feeCelo)}</span> CELO, once.
              </strong> It pays the one-time Altana registration fee for
              your wallet.
            </li>
          )}
        </ul>
        <p className="note">Send on Celo only. Funds sent on another network may be lost.</p>
      </Panel>

      <Panel title="Balances">
        {!b ? (
          <p className="waiting" role="status">
            <Spinner /> Checking Celo for your balances…
          </p>
        ) : (
          <>
            <dl className="facts">
              <div>
                <dt>USD₮</dt>
                <dd className="num">
                  {usdt(b.usdt)} {b.usdt > 0n ? <span className="tag tag--ok">Received</span> : <span className="tag">Waiting</span>}
                </dd>
              </div>
              {needsFee && reg && (
                <div>
                  <dt>CELO</dt>
                  <dd className="num">
                    {celo(b.celo)}{" "}
                    {b.celo >= reg.feeCelo ? (
                      <span className="tag tag--ok">Enough for the fee</span>
                    ) : (
                      <span className="tag">Waiting</span>
                    )}
                  </dd>
                </div>
              )}
            </dl>
            <p className="muted small">Checked <span className="num">{formatDateTime(b.observedAt)}</span></p>
          </>
        )}
      </Panel>

      {funded && onContinue ? (
        <Button block onClick={onContinue}>
          Continue: choose a plan
        </Button>
      ) : !funded ? (
        <p className="waiting" role="status">
          <Spinner /> This page updates by itself when your deposit arrives.
        </p>
      ) : null}
    </div>
  );
}
