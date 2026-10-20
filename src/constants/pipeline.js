export const PIPELINE_STAGES = [
  'sales_officer',
  'verifier',
  'ci_officer',
  'approver',
  'loan_processing_officer',
  'declined',
]

// Application status → display label + chip tone (admin list + detail).
export const STATUS_CHIP = {
  pending: { label: 'Pending', tone: 'x-chip--neutral' },
  approved: { label: 'Approved', tone: 'x-chip--positive' },
  declined: { label: 'Declined', tone: 'x-chip--negative' },
  pending_sa_confirmation: { label: 'Awaiting SA', tone: 'x-chip--warn' },
  withdrawn: { label: 'Withdrawn', tone: 'x-chip--neutral' },
}

export const STAGE_LABELS = {
  sales_officer: 'Sales Officer',
  verifier: 'Verifier',
  ci_officer: 'CI Officer',
  approver: 'Approver',
  loan_processing_officer: 'Loan Processing',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

// Why is an application currently sitting at the sales_officer stage?
//   'confirmation' — approver requested client confirmation (awaiting Confirm/Decline → approver)
//   'rework'       — verifier returned it for rework (awaiting Re-endorse → verifier)
//   'new'          — fresh lead (awaiting Endorse → verifier)
// Decided by event RECENCY (last_returned_at vs so_confirmation_sent_at), never by
// returned_count — that counter is cumulative and never resets, so it would wrongly
// flag any once-returned app as "in rework" forever.
export function getSoStageReason(app) {
  if (!app) return 'new'
  const pendingConfirmation = !!app.so_confirmation_sent_at && !app.so_decision
  const returnedAt = app.last_returned_at
  if (pendingConfirmation && returnedAt) {
    return new Date(app.so_confirmation_sent_at) >= new Date(returnedAt) ? 'confirmation' : 'rework'
  }
  if (pendingConfirmation) return 'confirmation'
  if (returnedAt) return 'rework'
  return 'new'
}

// Stages an application can be withdrawn from (backend guards `<stage>->withdrawn`).
export const WITHDRAWABLE_STAGES = ['sales_officer', 'verifier', 'ci_officer', 'approver']
