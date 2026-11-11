import { isNull } from "drizzle-orm";
import { enrollments } from "~/db/schema";

/**
 * The condition every "is this learner enrolled?" query must include. An
 * Enrollment ends when the learner's Refund Request is approved; it then no
 * longer grants access or counts towards enrollment numbers, though the
 * learner's Progress is kept (see docs/adr/0001).
 */
export function isActiveEnrollment() {
  return isNull(enrollments.endedAt);
}
