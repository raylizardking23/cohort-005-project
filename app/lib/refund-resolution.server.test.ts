import { describe, it, expect, vi } from "vitest";

vi.mock("~/db", () => ({ db: {} }));

import { RefundStatus } from "~/db/schema";
import { checkResolution } from "./refund-resolution.server";

describe("checkResolution", () => {
  it("lets an Admin approve an Open Refund Request", () => {
    expect(checkResolution(RefundStatus.Open, { decision: "approve" })).toEqual(
      { ok: true }
    );
  });

  it("lets an Admin decline an Open Refund Request with a Decline Note", () => {
    expect(
      checkResolution(RefundStatus.Open, {
        decision: "decline",
        declineNote: "You have finished most of the course.",
      })
    ).toEqual({ ok: true });
  });

  it("refuses to decline without a Decline Note", () => {
    expect(
      checkResolution(RefundStatus.Open, {
        decision: "decline",
        declineNote: "   ",
      })
    ).toEqual({ ok: false, reason: "decline-note-required" });
  });

  it.each([RefundStatus.Approved, RefundStatus.Declined])(
    "treats a %s Refund Request as final",
    (status) => {
      expect(checkResolution(status, { decision: "approve" })).toEqual({
        ok: false,
        reason: "already-resolved",
      });
      expect(
        checkResolution(status, { decision: "decline", declineNote: "No." })
      ).toEqual({ ok: false, reason: "already-resolved" });
    }
  );
});
