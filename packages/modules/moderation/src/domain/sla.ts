// A case's SLA as moderation, the owner of its clock, watches it: a warning at 75% of the time
// from opening to the due time, and the breach at the due time. The clock stops at the decision.

/** When a case opened at `openedAt` and due at `dueAt` has used 75% of its SLA (at once when due is not later). */
export function slaWarningAt(openedAt: Date, dueAt: Date): Date {
  const span = Math.max(0, dueAt.getTime() - openedAt.getTime())
  return new Date(openedAt.getTime() + Math.floor((span * 3) / 4))
}
