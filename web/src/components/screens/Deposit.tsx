"use client";

import { addressUrl, isFunded, type AutumnState } from "@/lib/autumn";
import { celo, formatDateTime, usdt } from "@/lib/format";
import { CostsList } from "../Costs";
import { Button, CopyButton, ExtLink, Panel, Qr, Spinner } from "../ui";

export function Deposit({
  state,
  onContinue,
  onBack,
  onSendOut,
}: {
  state: AutumnState;
  onContinue?: () => void;
  onBack?: () => void;
  onSendOut?: () => void;
}) {
  const wallet = state.wallet!;
  const b = state.balances;
  const reg = state.registration;
  const needsFee = reg ? reg.nextGrantFeeCelo > 0n : false;
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
              <CopyButton text={wallet.address} label="Copy address" what="wallet address" />
              <ExtLink href={addressUrl(wallet.address)} label="View your wallet address on Celoscan">
                View on Celoscan
              </ExtLink>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="What to send">
        <CostsList registration={reg} fees={state.fees} />
        <p className="note">Send on the Celo network only. Funds sent on another network may be lost.</p>
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
                    {b.celo >= reg.nextGrantFeeCelo ? (
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

      {onSendOut && (b?.usdt || b?.gold || b?.celo) ? (
        <Button variant="plain" block onClick={onSendOut}>
          Send funds out
        </Button>
      ) : null}

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
