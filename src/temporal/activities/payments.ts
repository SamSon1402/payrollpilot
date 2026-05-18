import { Context, heartbeat } from '@temporalio/activity';
import { prisma } from '../../lib/prisma';
import type { ExceptionPayload } from '../../lib/types';

/**
 * Payment execution activities — called from the per-employee child
 * workflow. The three steps:
 *
 *   submitPayment      → tell the bank to send the money (idempotent)
 *   awaitSettlement    → poll until the rail confirms settlement
 *   markPaymentSettled → persist the terminal state
 *
 * Splitting submission from settlement matters because settlement can
 * take minutes (SEPA Faster Payments SLA is 2 hours worst-case). If we
 * did both inside one activity, the worker would block; with the split,
 * the worker can do other work while we wait, and Temporal's heartbeat
 * keeps the activity alive without holding a thread.
 */

// Typed errors so the workflow retry policy can mark them non-retryable.
export class InvalidIbanError extends Error { constructor(m: string) { super(m); this.name = 'InvalidIbanError'; } }
export class AccountClosedError extends Error { constructor(m: string) { super(m); this.name = 'AccountClosedError'; } }
export class PaymentRejectedByBankError extends Error { constructor(m: string) { super(m); this.name = 'PaymentRejectedByBankError'; } }

export interface SubmitPaymentResult {
  transactionRef: string;
}

export async function submitPayment(args: { paymentId: string }): Promise<SubmitPaymentResult> {
  const payment = await prisma.employeePayment.findUniqueOrThrow({
    where: { id: args.paymentId },
  });

  if (!payment.iban) {
    throw new InvalidIbanError('payment row has no IBAN — reconcile stage missed something');
  }

  // Mark in-flight BEFORE the network call. If the call fails, we still
  // have a record that we tried. Temporal's retry will pick it up.
  await prisma.employeePayment.update({
    where: { id: args.paymentId },
    data: { status: 'EXECUTING' },
  });

  // TODO: real bank call
  //   const tx = await plaidPayments.create({
  //     idempotencyKey: payment.idempotencyKey,
  //     amount: Number(payment.netAmount),
  //     currency: payment.currency,
  //     iban: payment.iban,
  //     bic: payment.bic,
  //   });
  //   return { transactionRef: tx.id };

  return { transactionRef: `tx_${payment.idempotencyKey}` };
}

export interface SettlementResult {
  transactionRef: string;
  settledAt: string;
}

export async function awaitSettlement(args: {
  paymentId: string;
  transactionRef: string;
}): Promise<SettlementResult> {
  const deadline = Date.now() + 2 * 3600 * 1000;   // 2h SEPA SLA
  const ctx = Context.current();

  while (Date.now() < deadline) {
    // TODO: const status = await plaidPayments.get({ id: args.transactionRef });
    const status = await pollStub(args.transactionRef);

    if (status === 'SETTLED') {
      return { transactionRef: args.transactionRef, settledAt: new Date().toISOString() };
    }
    if (status === 'REJECTED') {
      throw new PaymentRejectedByBankError(`bank rejected ${args.transactionRef}`);
    }

    // Heartbeat tells Temporal we're alive — without this, the activity
    // would be considered failed after the heartbeat timeout and a retry
    // would re-submit the payment (the idempotency key saves us from a
    // double-payment but we still want to avoid wasted work).
    heartbeat('polling');
    await sleep(5000);
    if (ctx.cancellationSignal.aborted) throw new Error('settlement polling cancelled');
  }
  throw new Error(`settlement timed out for ${args.transactionRef}`);
}

export async function markPaymentSettled(args: {
  paymentId: string;
  transactionRef: string;
  settledAt: string;
}): Promise<void> {
  await prisma.employeePayment.update({
    where: { id: args.paymentId },
    data: {
      status: 'SETTLED',
      transactionRef: args.transactionRef,
      settledAt: new Date(args.settledAt),
    },
  });
}

export async function markPaymentFailed(args: {
  paymentId: string;
  reason: string;
}): Promise<void> {
  await prisma.employeePayment.update({
    where: { id: args.paymentId },
    data: { status: 'FAILED', failureReason: args.reason },
  });
}

export async function recordEmployeeException(args: {
  runId: string;
  paymentId: string;
  reason: string;
}): Promise<void> {
  const payload: ExceptionPayload = {
    type: 'PAYMENT_REJECTED_BY_BANK',
    employeeRef: args.paymentId,
    bankCode: 'unknown',
    bankMessage: args.reason,
  };
  await prisma.exception.create({
    data: {
      runId: args.runId,
      employeeId: args.paymentId,
      type: 'PAYMENT_REJECTED_BY_BANK',
      state: 'PENDING_RESOLUTION',
      detectedAtStage: 'EXECUTE',
      payload: payload as never,
    },
  });
}

export async function listPayableEmployees(args: { runId: string }): Promise<{ id: string }[]> {
  return prisma.employeePayment.findMany({
    where: { runId: args.runId, status: 'QUEUED' },
    select: { id: true },
  });
}

// Helpers
async function pollStub(ref: string): Promise<'PENDING' | 'SETTLED' | 'REJECTED'> {
  // Deterministic-ish stub so demo runs don't flap.
  return ref.length % 7 === 0 ? 'REJECTED' : 'SETTLED';
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
