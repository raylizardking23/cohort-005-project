# A Refund Request and a Refund are separate lifecycles

The learner's ask (Refund Request: Open, Approved, Declined) and the money going back (Refund: Pending, Issued, Failed) are modelled as two things with their own statuses, not one status list. Mixing them is what let the screens call the same thing "Pending Chargeback" and "Reversal requested". Keeping them apart means "pending" can only ever describe money in flight, never a decision still to be made. For now only the Refund Request is stored; Refund statuses will be stored when the payment step is built, and a Failed Refund is retried without reopening the request.

## Considered Options

- **One combined status list** (requested → approved → paid / failed / declined). Fewer moving parts, but it puts a decision and a payment on one axis and invites the same naming confusion again.
