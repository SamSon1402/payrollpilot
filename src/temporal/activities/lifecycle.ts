import { prisma } from '../../lib/prisma';

/**
 * Finalize a run — aggregate per-employee outcomes into the run summary.
 *
 * Kept as a separate activity because it's a single DB transaction at
 * the end that also flips the run status, and we want it audited as a
 * distinct lifecycle event in Temporal history.
 */

export interface FinalizeResult {
  paidCount: number;
  excludedCount: number;
  failedCount: number;
  totalPaidMinorUnits: number;
}

export async function finalizeRun(args: { runId: string }): Promise<FinalizeResult> {
  const employees = await prisma.employeePayment.findMany({
    where: { runId: args.runId },
    select: { status: true, netAmount: true },
  });

  let paidCount = 0;
  let excludedCount = 0;
  let failedCount = 0;
  let totalPaidMinorUnits = 0;

  for (const e of employees) {
    if (e.status === 'SETTLED') {
      paidCount++;
      totalPaidMinorUnits += Math.round(Number(e.netAmount) * 100);
    } else if (e.status === 'EXCLUDED') {
      excludedCount++;
    } else if (e.status === 'FAILED') {
      failedCount++;
    }
  }

  await prisma.payrollRun.update({
    where: { id: args.runId },
    data: {
      status: 'COMPLETED',
      paidTotal: totalPaidMinorUnits / 100,
      completedAt: new Date(),
    },
  });

  return { paidCount, excludedCount, failedCount, totalPaidMinorUnits };
}
