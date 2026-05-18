import { proxyActivities, log } from '@temporalio/workflow';
import type * as activities from '../activities';

/**
 * Per-employee child workflow.
 *
 * Why one workflow per employee instead of one big `Promise.all` inside
 * the parent?
 *
 *   • Failure isolation. If Sofia's payment fails 3 retries and gives
 *     up, the parent gets `rejected` for that child only — the other 27
 *     are unaffected. With a flat Promise.all and a thrown error you'd
 *     have to manually swallow exceptions everywhere or risk one bad
 *     IBAN nuking the whole run.
 *
 *   • Per-employee Temporal history. Replay, search, retries — all
 *     scoped per employee. When AP needs to know exactly what happened
 *     to one person's payment, they get a clean event timeline, not a
 *     filtered slice of a 1000-event parent history.
 *
 *   • Different retry policies per employee class (we don't yet, but
 *     this is the seam — e.g. SEPA Faster vs SWIFT have very different
 *     reasonable retry windows).
 */

const acts = proxyActivities<typeof activities>({
  // Initiating the payment is the cheap part; settlement confirmation
  // can take minutes for SEPA. We split it into two activities so the
  // worker isn't blocked.
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '2s',
    maximumInterval: '5m',
    backoffCoefficient: 2,
    maximumAttempts: 5,
    nonRetryableErrorTypes: [
      // These come back from the bank deterministically — retrying
      // won't help and just delays the human resolution.
      'InvalidIbanError',
      'AccountClosedError',
      'PaymentRejectedByBankError',
    ],
  },
});

export interface EmployeePaymentInput {
  paymentId: string;
  runId: string;
}

export async function employeePaymentWorkflow(
  input: EmployeePaymentInput,
): Promise<{ status: 'SETTLED' | 'FAILED'; transactionRef?: string }> {
  const { paymentId, runId } = input;
  log.info('payment.start', { paymentId });

  try {
    // 1. Submit. Activity reads the row, builds the deterministic
    //    idempotency key, calls Plaid Payments / direct bank API.
    const submission = await acts.submitPayment({ paymentId });

    // 2. Poll for settlement. SEPA Faster Payments usually settles in
    //    seconds but the spec allows up to 2 hours. The poll activity
    //    has its own heartbeat — Temporal won't think the worker is
    //    dead just because we're waiting on the rail.
    const settlement = await acts.awaitSettlement({
      paymentId,
      transactionRef: submission.transactionRef,
    });

    await acts.markPaymentSettled({
      paymentId,
      transactionRef: settlement.transactionRef,
      settledAt: settlement.settledAt,
    });

    return { status: 'SETTLED', transactionRef: settlement.transactionRef };
  } catch (err) {
    // Non-retryable bank rejection or retries exhausted. Mark failed
    // and create an exception so AP can intervene. The parent workflow
    // doesn't block on individual employee exceptions — they're
    // resolved out-of-band post-run.
    const message = (err as Error).message;
    await acts.markPaymentFailed({ paymentId, reason: message });
    await acts.recordEmployeeException({
      runId,
      paymentId,
      reason: message,
    });
    return { status: 'FAILED' };
  }
}
