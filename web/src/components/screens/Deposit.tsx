"use client";

import { addressUrl, isFunded, type AutumnState } from "@/lib/autumn";
import { celo, formatDateTime, usdt } from "@/lib/format";
import { CostsList } from "../Costs";
import { BackupChip, Button, CopyButton, ExtLink, Label, Panel, Qr, ScreenHead, Spinner, Trail, isDeviceBound } from "../ui";

export function Deposit({
  state,
  onContinue,
  onBack,
  onSendOut,
  onBackupCode,
}: {
  state: AutumnState;
  onContinue?: () => void;
  onBack?: () => void;
  onSendOut?: () => void;
  onBackupCode?: () => void;
}) {
  const wallet = state.wallet!;
  const b = state.balances;
  const reg = state.registration;
  const needsFee = reg ? reg.nextGrantFeeCelo > 0n : false;
  const funded = isFunded(state);
  const groups = wallet.address.slice(2).match(/.{1,4}/g) ?? [];

  return (
    <div className="screen">
      <ScreenHead title="Add money" onBack={onBack} />
      {onContinue && state.plan === null && <Trail at={1} />}

      <div className="screen__grid">
      <div className="stack">
      <Panel title="Your wallet address" icon="wallet">
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
        {onBackupCode && isDeviceBound(wallet) && <BackupChip onBackupCode={onBackupCode} />}
      </Panel>

      <Panel title="Balances" icon="pouch">
        {!b ? (
          <p className="waiting" role="status">
            <Spinner /> Checking Celo for your balances…
          </p>
        ) : (
          <>
            <dl className="facts facts--big">
              <div>
                <dt>
                  <Label icon="note">USD₮</Label>
                </dt>
                <dd className="num">
                  {usdt(b.usdt)} {b.usdt > 0n ? <span className="tag tag--ok">Received</span> : <span className="tag">Waiting</span>}
                </dd>
              </div>
              {needsFee && reg && (
                <div>
                  <dt>
                    <Label icon="token">CELO</Label>
                  </dt>
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
      </div>

      <Panel title="What to send" icon="coin">
        <CostsList registration={reg} fees={state.fees} />
        <p className="note">Send on the Celo network only. Funds sent on another network may be lost.</p>
      </Panel>
      </div>

      <div className="screen__actions">
      {funded && onContinue ? (
        <Button block onClick={onContinue}>
          Continue: choose a plan
        </Button>
      ) : !funded ? (
        <p className="waiting" role="status">
          <Spinner /> This page updates by itself when your deposit arrives.
        </p>
      ) : null}

      {onSendOut && (b?.usdt || b?.gold || b?.celo) ? (
        <Button variant="plain" block onClick={onSendOut}>
          Send funds out
        </Button>
      ) : null}
      </div>
    </div>
  );
}
