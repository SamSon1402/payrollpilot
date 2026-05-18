import { createHash } from 'node:crypto';

/**
 * Idempotency keys for outbound payments.
 *
 * The contract:
 *   - Same (run, employee, amount) → same key, forever.
 *   - Different amount → different key (a salary correction MUST be a
 *     separate payment, not a silent overwrite).
 *
 * Why this matters for Temporal: activity retries are at-least-once.
 * Without an idempotency key the bank API, on the retry of a payment
 * activity that timed out after the funds left, would happily debit a
 * second time. With this key, the bank's own idempotency layer rejects
 * the duplicate and the activity completes cleanly.
 *
 * SHA-256 truncated to 32 hex chars — collisions astronomically
 * improbable within a single org's lifetime, and the result is short
 * enough to fit comfortably in most bank API constraints (Plaid's
 * idempotency-key header maxes at 100).
 */

export interface PaymentKeyInputs {
  runId: string;
  employeeRef: string;
  netAmount: number;
  currency: string;
}

export function paymentIdempotencyKey(inputs: PaymentKeyInputs): string {
  const canonical = [
    'pay',
    inputs.runId,
    inputs.employeeRef,
    inputs.currency,
    // Store amounts as integer minor units to dodge floating-point
    // representation differences (£100.10 must hash the same across
    // any code path that builds the key).
    Math.round(inputs.netAmount * 100).toString(10),
  ].join(':');

  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return `pp_${hash}`;
}
