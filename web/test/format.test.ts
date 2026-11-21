import { describe, expect, it } from "vitest";
import { approxUsd, bpsPercent, relative } from "../src/lib/format";
import { suggestedDeposit } from "../src/lib/autumn";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms);

describe("relative", () => {
  it("never words a past instant as the future", () => {
    expect(relative(at(-5_000), NOW)).toBe("just now");
    expect(relative(at(-3 * 60_000), NOW)).toBe("3 minutes ago");
    expect(relative(at(-60_000), NOW)).toBe("1 minute ago");
    expect(relative(at(-2 * 3_600_000), NOW)).toBe("2 hours ago");
    expect(relative(at(-3 * 86_400_000), NOW)).toBe("3 days ago");
  });

  it("clamps an event the chain's clock puts slightly ahead of this device to 'just now'", () => {
    expect(relative(at(8_000), NOW, { past: true })).toBe("just now");
    expect(relative(at(5 * 60_000), NOW, { past: true })).toBe("just now");
  });

  it("words future times plainly", () => {
    expect(relative(at(10_000), NOW)).toBe("in less than a minute");
    expect(relative(at(30 * 60_000), NOW)).toBe("in 30 minutes");
    expect(relative(at(3_600_000), NOW)).toBe("in 1 hour");
  });
});

describe("money words", () => {
  it("formats approximate dollars and percentages", () => {
    expect(approxUsd(1_044_284n)).toBe("about $1.04");
    expect(approxUsd(5_000n)).toBe("under $0.01");
    expect(bpsPercent(40)).toBe("0.40%");
  });

  it("suggests a deposit covering every scheduled buy and its fee allowance", () => {
    expect(suggestedDeposit(5_000_000n, "week")).toBe(60_600_000n); // 12 × 5.05
    expect(suggestedDeposit(1_000_000n, "day")).toBe(88_200_000n); // 84 × 1.05
  });
});
