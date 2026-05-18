import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getTemporalClient } from '@/lib/temporal-client';

/**
 * GET /api/payroll-runs/[id]
 *
 * Full status of a run: stage, pipeline state, per-employee counts,
 * pending exceptions, audit timeline. This is what powers the cockpit
 * view in the UI.
 *
 * Reads the stage from Temporal directly (via the `currentStage` query)
 * rather than the DB, so if a worker just updated the workflow's stage
 * but hasn't flushed to Postgres yet, the UI sees the latest truth.
 */

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  ctx: { params: { id: string } }
): Promise<NextResponse> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: ctx.params.id },
    include: {
      _count: { select: { employees: true } },
      employees: {
        select: {
          id: true, employeeRef: true, employeeName: true,
          status: true, netAmount: true, currency: true,
          settledAt: true, failureReason: true,
        },
      },
      exceptions: {
        where: { state: { in: ['DETECTED', 'PENDING_RESOLUTION'] } },
        orderBy: { createdAt: 'desc' },
      },
      approvals: { orderBy: { createdAt: 'desc' } },
      events: { orderBy: { timestamp: 'asc' }, take: 200 },
    },
  });

  if (!run) {
    return NextResponse.json({ error: 'run_not_found' }, { status: 404 });
  }

  // Live stage from Temporal — fallback to DB if workflow already closed.
  let liveStage: string | null = null;
  if (run.status === 'RUNNING' || run.status === 'AWAITING_APPROVAL') {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(`payroll-${run.id}`);
      liveStage = await handle.query<string>('currentStage');
    } catch {
      // Workflow closed or unreachable; the DB stage is good enough.
    }
  }

  const byStatus = run.employees.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    id: run.id,
    status: run.status,
    currentStage: liveStage ?? run.currentStage,
    periodStart: run.periodStart,
    periodEnd:   run.periodEnd,
    payDate:     run.payDate,
    currency:    run.currency,
    expectedTotal: run.expectedTotal,
    paidTotal:     run.paidTotal,
    counts: {
      total:    run._count.employees,
      queued:   byStatus.QUEUED   ?? 0,
      excluded: byStatus.EXCLUDED ?? 0,
      executing: byStatus.EXECUTING ?? 0,
      settled:  byStatus.SETTLED ?? 0,
      failed:   byStatus.FAILED  ?? 0,
    },
    pendingExceptions: run.exceptions,
    approvals: run.approvals,
    events: run.events,
  });
}
