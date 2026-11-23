/**
 * The plan screen's amount, as pure functions of what the owner picked: one of
 * the presets, or "Custom" with the text typed. Kept out of the component so
 * the empty, invalid and valid states stay distinct and testable.
 */
import { parsePlanAmountText } from "@autumn/core";
import { DECIMALS, PLAN_PRESETS_USDT } from "./autumn";
import { usdt } from "./format";

export type PlanPreset = (typeof PLAN_PRESETS_USDT)[number];
/** A preset amount in whole USD₮, or the custom amount field. */
export type AmountChoice = PlanPreset | "custom";

export type PlanAmountView =
  /** "Custom" with nothing typed yet. */
  | { kind: "empty" }
  | { kind: "invalid"; problem: string }
  /** USD₮ base units per purchase, within the plan rules (1 to 100 USD₮, steps of 0.01). */
  | { kind: "ok"; amount: bigint };

const UNIT = 10n ** BigInt(DECIMALS.USDT);

/** The amount per purchase for the choice. The custom text is parsed like the other screens (a decimal comma works). */
export function planAmountView(choice: AmountChoice, customText: string): PlanAmountView {
  if (choice !== "custom") return { kind: "ok", amount: BigInt(choice) * UNIT };
  if (customText.trim() === "") return { kind: "empty" };
  const parsed = parsePlanAmountText(customText);
  return parsed.ok ? { kind: "ok", amount: parsed.value } : { kind: "invalid", problem: parsed.problem };
}

/** "$5" for a whole amount (as the presets read), "$4.50" otherwise. */
export function dollarLabel(amount: bigint): string {
  return amount % UNIT === 0n ? `$${amount / UNIT}` : `$${usdt(amount)}`;
}
