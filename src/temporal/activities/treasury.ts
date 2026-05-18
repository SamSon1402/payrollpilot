import { prisma } from '../../lib/prisma';
import type { ExceptionPayload } from '../../lib/types';

/**
 * FUND stage — make sure the operating account has enough liquidity
 * to cover the run before EXECUTE starts firing payments.
 *
 * The smartest thing this stage does is fail FAST and informatively:
 * we'd rather pause for a 10-minute MMF sweep than fire 14 payments,
 * have the 15th get rejected for NSF, and have to manually reconcile
 * what settled vs what didn't. Treasury check before payment
 * initiation is the single biggest correctness win in payroll.
 */

export interface FundResult {
  fundedTotal: number;
  exceptionId?: string;
}

const OPERATING_ACCOUNT_ID = 'hsbc-001';

export async function fundRun(args: { runId: string }): Promise<FundResult> {
  const run = await prisma.payrollRun.findUniqueOrThrow({
    where: { id: args.runId },
    include: {
      employees: {
        where: { status: 'QUEUED' },
        select: { netAmount: true, currency: true },
      },
    },
  });

  // Required is the sum of net payments in the run currency. (Multi-
  // currency would be summed per currency and FX-quoted in production
  // — kept GBP-only here for clarity.)
  const required = run.employees.reduce((s, e) => s + Number(e.netAmount), 0);

  const available = await fetchAccountBalance(OPERATING_ACCOUNT_ID);

  if (available >= required) {
    await prisma.payrollRun.update({
      where: { id: args.runId },
      data: { fundedTotal: required },
    });
    return { fundedTotal: required };
  }

  // Insufficient — create the exception and surface the suggested
  // remediation. The /resolve API will run the MMF sweep activity,
  // resolve the exception, and the workflow will retry fundRun().
  const shortfall = required - available;
  const payload: ExceptionPayload = {
    type: 'INSUFFICIENT_TREASURY',
    required,
    available,
    shortfall,
    currency: run.currency,
    suggestedSource: 'MMF_SWEEP',
  };
  const ex = await prisma.exception.create({
    data: {
      runId: args.runId,
      type: 'INSUFFICIENT_TREASURY',
      state: 'PENDING_RESOLUTION',
      detectedAtStage: 'FUND',
      payload: payload as never,
    },
  });
  return { fundedTotal: 0, exceptionId: ex.id };
}

/**
 * Sweep money from MMF → operating account. Called by the /resolve
 * endpoint to clear an INSUFFICIENT_TREASURY exception. Idempotent on
 * the bank side via a deterministic reference.
 */
export async function sweepFromMmfToOperating(args: {
  runId: string;
  amount: number;
}): Promise<{ reference: string }> {
  // TODO: real Insignis withdrawal + Plaid Payments transfer
  //   const ref = `INS-W-${args.runId}-${Math.floor(args.amount)}`;
  //   await insignis.withdraw({ amount: args.amount, idempotencyKey: ref });
  //   await plaidPayments.transfer({ to: OPERATING_ACCOUNT_ID, amount: args.amount });
  return { reference: `INS-W-${args.runId}-${Math.floor(args.amount)}` };
}

async function fetchAccountBalance(_accountId: string): Promise<number> {
  // TODO: real Plaid AISP balance call
  return 80_000;  // intentionally low to demo the exception path
}
