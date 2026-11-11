import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  videoWatchEvents,
  LessonProgressStatus,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundIneligibleReason =
  | "no-purchase"
  | "already-requested"
  | "window-closed"
  | "completed-too-much"
  | "watched-too-much";

export type RefundEligibility =
  | {
      eligible: true;
      purchaseId: number;
      refundAmount: number;
      lastDayInWindow: string;
    }
  | { eligible: false; reason: RefundIneligibleReason };

export type RefundFacts = {
  purchase: { id: number; amountPaid: number; createdAt: string };
  hasRefundRequest: boolean;
  completedLessons: number;
  totalLessons: number;
  secondsWatched: number;
};

export const INELIGIBLE_RESPONSES: Record<
  RefundIneligibleReason,
  { message: string; status: number }
> = {
  "no-purchase": {
    message: "You have no personal purchase of this course to refund.",
    status: 403,
  },
  "already-requested": {
    message: "You have already made a refund request for this purchase.",
    status: 409,
  },
  "window-closed": {
    message: `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
    status: 403,
  },
  "completed-too-much": {
    message:
      "You have completed too much of this course to request a refund.",
    status: 403,
  },
  "watched-too-much": {
    message: "You have watched too much of this course to request a refund.",
    status: 403,
  },
};

// The window is counted in whole calendar days, not hours — someone who buys
// at 23:00 still gets the whole of their fourteenth day.
export function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

/**
 * Decides Refund Eligibility from facts already gathered. The Refund Amount
 * is always what the learner actually paid.
 */
export function decideRefundEligibility(
  facts: RefundFacts,
  now: Date
): RefundEligibility {
  if (facts.hasRefundRequest) {
    return { eligible: false, reason: "already-requested" };
  }

  const purchasedAt = new Date(facts.purchase.createdAt);
  const windowEnd = new Date(purchasedAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = calendarDay(windowEnd);
  const today = calendarDay(now);

  if (today < calendarDay(purchasedAt) || today > lastDayInWindow) {
    return { eligible: false, reason: "window-closed" };
  }

  if (
    facts.totalLessons > 0 &&
    facts.completedLessons / facts.totalLessons >= REFUND_COMPLETION_LIMIT
  ) {
    return { eligible: false, reason: "completed-too-much" };
  }

  if (facts.secondsWatched >= REFUND_WATCH_LIMIT_SECONDS) {
    return { eligible: false, reason: "watched-too-much" };
  }

  return {
    eligible: true,
    purchaseId: facts.purchase.id,
    refundAmount: facts.purchase.amountPaid,
    lastDayInWindow,
  };
}

/**
 * The learner's latest Personal Purchase of the course. A purchase that minted
 * coupons is a Seat Purchase and can never be refunded (see docs/adr/0004).
 */
function getLatestPersonalPurchase(userId: number, courseId: number) {
  const mintedSeats = db
    .select({ one: sql`1` })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchases.id));

  return db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        notExists(mintedSeats)
      )
    )
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

export function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

export function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

export function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

/**
 * Whether the learner can make a Refund Request on their latest purchase of
 * this course. A purchase gets one Refund Request, whatever its status.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number,
  now: Date = new Date()
): RefundEligibility {
  const purchase = getLatestPersonalPurchase(userId, courseId);
  if (!purchase) return { eligible: false, reason: "no-purchase" };

  const refundRequest = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(eq(refunds.purchaseId, purchase.id))
    .get();

  const lessonIds = getLessonIdsForCourse(courseId);

  return decideRefundEligibility(
    {
      purchase,
      hasRefundRequest: Boolean(refundRequest),
      completedLessons: getCompletedLessonCount(userId, lessonIds),
      totalLessons: lessonIds.length,
      secondsWatched: getSecondsWatched(userId, lessonIds),
    },
    now
  );
}
