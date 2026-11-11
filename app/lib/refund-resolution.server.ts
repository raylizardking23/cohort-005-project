import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courseRatings,
  courses,
  enrollments,
  purchases,
  refunds,
  users,
  RefundStatus,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";

export type ResolutionDecision =
  | { decision: "approve" }
  | { decision: "decline"; declineNote: string };

export type ResolutionCheck =
  | { ok: true }
  | { ok: false; reason: "already-resolved" | "decline-note-required" };

/** A Resolution is final: only an Open Refund Request can be resolved. */
export function checkResolution(
  status: RefundStatus,
  decision: ResolutionDecision
): ResolutionCheck {
  if (status !== RefundStatus.Open) {
    return { ok: false, reason: "already-resolved" };
  }

  if (decision.decision === "decline" && decision.declineNote.trim() === "") {
    return { ok: false, reason: "decline-note-required" };
  }

  return { ok: true };
}

/**
 * A purchase's amount paid, less anything refunded on an Approved Refund
 * Request. Use in place of `purchases.amountPaid` wherever revenue is summed.
 */
export const netAmountPaid = sql<number>`(${purchases.amountPaid} - coalesce((select sum(${refunds.amountRefunded}) from ${refunds} where ${refunds.purchaseId} = ${purchases.id} and ${refunds.status} = ${RefundStatus.Approved}), 0))`;

function getRefundRequestForResolution(refundId: number) {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      purchaseId: purchases.id,
      refundAmount: purchases.amountPaid,
      courseId: courses.id,
      courseTitle: courses.title,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .where(eq(refunds.id, refundId))
    .get();
}

type ResolvedRefundRequest = NonNullable<
  ReturnType<typeof getRefundRequestForResolution>
>;

export type ResolutionResult =
  | { ok: true; email: { to: string; subject: string; body: string } }
  | { ok: false; reason: "not-found" | "already-resolved" | "decline-note-required" };

/**
 * Resolves an Open Refund Request. Approving ends the learner's Enrollment and
 * removes their rating, but keeps their Progress and comments (see
 * docs/adr/0001). Returns the email to send the learner.
 */
export function resolveRefundRequest(
  refundId: number,
  adminId: number,
  decision: ResolutionDecision,
  now: Date = new Date()
): ResolutionResult {
  const request = getRefundRequestForResolution(refundId);
  if (!request) return { ok: false, reason: "not-found" };

  const check = checkResolution(request.status, decision);
  if (!check.ok) return check;

  const resolvedAt = now.toISOString();

  if (decision.decision === "approve") {
    db.transaction((tx) => {
      tx.update(refunds)
        .set({
          status: RefundStatus.Approved,
          amountRefunded: request.refundAmount,
          resolvedAt,
          resolvedByUserId: adminId,
        })
        .where(eq(refunds.id, refundId))
        .run();

      tx.update(enrollments)
        .set({ endedAt: resolvedAt })
        .where(
          and(
            eq(enrollments.userId, request.learnerId),
            eq(enrollments.courseId, request.courseId),
            isNull(enrollments.endedAt)
          )
        )
        .run();

      tx.delete(courseRatings)
        .where(
          and(
            eq(courseRatings.userId, request.learnerId),
            eq(courseRatings.courseId, request.courseId)
          )
        )
        .run();
    });

    return { ok: true, email: buildApprovedEmail(request) };
  }

  const declineNote = decision.declineNote.trim();

  db.update(refunds)
    .set({
      status: RefundStatus.Declined,
      declineNote,
      resolvedAt,
      resolvedByUserId: adminId,
    })
    .where(eq(refunds.id, refundId))
    .run();

  return { ok: true, email: buildDeclinedEmail(request, declineNote) };
}

function buildApprovedEmail(request: ResolvedRefundRequest) {
  return {
    to: request.learnerEmail,
    subject: `Refund approved - ${request.courseTitle}`,
    body: [
      `Hi ${request.learnerName},`,
      "",
      `We have approved your refund request for "${request.courseTitle}".`,
      `We will refund ${formatPrice(request.refundAmount)}, the amount you paid, to the card you paid with.`,
      "",
      "You no longer have access to the course. If you buy it again, you will pick up where you left off.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function buildDeclinedEmail(
  request: ResolvedRefundRequest,
  declineNote: string
) {
  return {
    to: request.learnerEmail,
    subject: `Refund request declined - ${request.courseTitle}`,
    body: [
      `Hi ${request.learnerName},`,
      "",
      `We have declined your refund request for "${request.courseTitle}".`,
      "",
      declineNote,
      "",
      "You still have full access to the course.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
