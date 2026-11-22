"use client";

import { addressUrl, isFunded, type AutumnClient, type AutumnState } from "@/lib/autumn";
import { celo, formatDateTime, usdt } from "@/lib/format";
import { CostsList } from "../Costs";
import { BackupChip, Button, CopyButton, ExtLink, Label, Panel, Qr, ScreenHead, Spinner, Trail, isDeviceBound } from "../ui";
import { IdentityLine } from "./Home";

export function Deposit({
  client,
  state,
  onContinue,
  onBack,
  onSendOut,
  onBackupCode,
  forNewPlan,
}: {
  client?: AutumnClient;
  state: AutumnState;
  /** Opened from "Start a new plan" without enough CELO: say how much more the new plan's registration needs. */
  forNewPlan?: boolean;
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
        {onBackupCode && <BackupChip onBackupCode={onBackupCode} deviceBound={isDeviceBound(wallet)} />}
        {client && state.plan === null && reg?.walletRegistered && (
          <p className="muted small">
            Agent identity: <IdentityLine client={client} identity={state.identity} />
          </p>
        )}
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
      {forNewPlan && !funded && b && reg && b.celo < reg.nextGrantFeeCelo && (
        <p className="note" role="status">
          A new plan needs about <span className="num">{celo(reg.nextGrantFeeCelo - b.celo)}</span> more CELO for Altana&apos;s registration
          of the agent&apos;s new key (<span className="num">{celo(reg.nextGrantFeeCelo)}</span> CELO in all).
        </p>
      )}
      {forNewPlan && !funded && b && b.usdt === 0n && (
        <p className="note" role="status">
          A new plan needs some USD₮ in the wallet to buy with.
        </p>
      )}
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
