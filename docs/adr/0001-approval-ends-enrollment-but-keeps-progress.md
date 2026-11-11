# Approving a refund ends the Enrollment but keeps Progress

When an Admin approves a Refund Request, the learner's Enrollment is marked as ended rather than deleted, and their Progress (lessons completed, watch history, quiz attempts) and comments are kept. Their course rating is deleted. Access lasts the whole time the request is Open and ends at the moment of approval; eligibility is not re-checked then. We keep Progress so a learner who buys again picks up where they left off, and because deleting it cannot be undone and would quietly distort course statistics. The rating goes because it no longer reflects a paying learner's view; comments stay because they are part of a conversation other learners rely on.

## Considered Options

- **Delete the Enrollment and all Progress.** Simplest to query, but irreversible, and a returning learner would start from zero.
- **Pause access while the request is Open.** Stops a learner watching past the limits after asking, but punishes the many genuine requests to guard against a few. The Admin sees current Progress when deciding, which covers this.
- **Re-check eligibility at approval.** Rejected for the same reason: the Admin's judgement replaces it.

## Consequences

- Every query that asks "is this learner enrolled?" must ignore ended Enrollments. That covers the dashboard, the course page, lessons and enrollment counts.
- Progress rows can exist with no active Enrollment. Code must not assume that one implies the other.
- Deleting the rating is the one irreversible step in an approval.
