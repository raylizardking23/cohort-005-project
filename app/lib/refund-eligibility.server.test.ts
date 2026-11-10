import { describe, it, expect, vi } from "vitest";

vi.mock("~/db", () => ({ db: {} }));

import {
  decideRefundEligibility,
  type RefundFacts,
} from "./refund-eligibility.server";

const purchasedAt = new Date(2026, 0, 1, 23, 0);

function facts(overrides: Partial<RefundFacts> = {}): RefundFacts {
  return {
    purchase: { id: 7, amountPaid: 4900, createdAt: purchasedAt.toISOString() },
    hasRefundRequest: false,
    isClaimedSeat: false,
    completedLessons: 0,
    totalLessons: 10,
    secondsWatched: 0,
    ...overrides,
  };
}

describe("decideRefundEligibility", () => {
  it("offers the amount the learner actually paid as the Refund Amount", () => {
    const result = decideRefundEligibility(facts(), new Date(2026, 0, 2));
    expect(result).toEqual({
      eligible: true,
      purchaseId: 7,
      refundAmount: 4900,
      lastDayInWindow: "2026-01-15",
    });
  });

  it("keeps the window open through the whole fourteenth day", () => {
    const result = decideRefundEligibility(facts(), new Date(2026, 0, 15, 23));
    expect(result.eligible).toBe(true);
  });

  it("closes the window the day after", () => {
    const result = decideRefundEligibility(facts(), new Date(2026, 0, 16));
    expect(result).toEqual({ eligible: false, reason: "window-closed" });
  });

  it("allows only one Refund Request per purchase", () => {
    const result = decideRefundEligibility(
      facts({ hasRefundRequest: true }),
      new Date(2026, 0, 2)
    );
    expect(result).toEqual({ eligible: false, reason: "already-requested" });
  });

  it("refuses a claimed team seat", () => {
    const result = decideRefundEligibility(
      facts({ isClaimedSeat: true }),
      new Date(2026, 0, 2)
    );
    expect(result).toEqual({ eligible: false, reason: "claimed-seat" });
  });

  it("refuses once half the lessons are completed", () => {
    const result = decideRefundEligibility(
      facts({ completedLessons: 5 }),
      new Date(2026, 0, 2)
    );
    expect(result).toEqual({ eligible: false, reason: "completed-too-much" });
  });

  it("refuses once two hours have been watched", () => {
    const result = decideRefundEligibility(
      facts({ secondsWatched: 2 * 60 * 60 }),
      new Date(2026, 0, 2)
    );
    expect(result).toEqual({ eligible: false, reason: "watched-too-much" });
  });
});
