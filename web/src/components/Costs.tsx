"use client";

import { DECIMALS, PLAN_DURATION_WEEKS, suggestedDeposit, type FeeFacts, type Registration } from "@/lib/autumn";
import { approxUsd, celo, usdt } from "@/lib/format";

const DEFAULT_AMOUNT = 5n * 10n ** BigInt(DECIMALS.USDT);

/** CELO wei → USD₮ base units at the onchain rate. */
export const celoInUsdt = (wei: bigint, fees: FeeFacts) => (wei * fees.usdtPerCelo) / 10n ** 18n;

/**
 * What to send and what it costs, in plain words: a suggested USD₮ deposit,
 * the CELO the registration needs (with its dollar value from the onchain
 * rate), the two passkey prompts, and that stopping and sending out cost a
 * passkey approval and a small fee.
 */
export function CostsList({ registration, fees }: { registration: Registration | null; fees: FeeFacts | null }) {
  const first = registration ? registration.nextGrantFeeCelo : null;
  const later = registration ? registration.perKeyFeeCelo : null;
  const usd = (wei: bigint) => (fees ? ` (${approxUsd(celoInUsdt(wei, fees))} at today's price)` : "");
  return (
    <ul className="send-list">
      <li>
        <strong>USD₮ for the gold.</strong> <span className="num">$5</span> a week for <span className="num">{PLAN_DURATION_WEEKS}</span> weeks needs about{" "}
        <span className="num">{usdt(suggestedDeposit(DEFAULT_AMOUNT, "week"))}</span> USD₮, fee allowance included. Any amount works: the agent skips a
        purchase when the balance runs out.
      </li>
      <li>
        <strong>CELO for Altana&apos;s registration.</strong>{" "}
        {first !== null && later !== null && registration ? (
          registration.walletRegistered ? (
            <>
              Each new plan needs about <span className="num">{celo(later)}</span> CELO{usd(later)}. Any excess is refunded.
            </>
          ) : (
            <>
              About <span className="num">{celo(first)}</span> CELO{usd(first)} for your first plan, and about{" "}
              <span className="num">{celo(later)}</span> CELO more for each new plan after it. Any excess is refunded.
            </>
          )
        ) : (
          <>The amount is read from Celo when your wallet is open.</>
        )}
      </li>
      <li>Starting a plan asks for your passkey twice: once to grant the agent its limits, once for its onchain identity (ERC-8004).</li>
      <li>Stopping the agent, and sending funds out, each need a passkey approval and a small network fee.</li>
      <li>
        <strong>You can send your funds out at any time</strong>, whether the agent is running or stopped.
      </li>
    </ul>
  );
}
