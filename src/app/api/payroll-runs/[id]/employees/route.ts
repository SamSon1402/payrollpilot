import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/payroll-runs/[id]/employees
 *
 * Per-employee payment status. Used by the cockpit grid in the UI.
 * Supports optional `?status=SETTLED` etc. for filtering.
 *
 *   curl http://localhost:3000/api/payroll-runs/<id>/employees
 *   curl 'http://localhost:3000/api/payroll-runs/<id>/employees?status=FAILED'
 */

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  ctx: { params: { id: string } }
): Promise<NextResponse> {
  const status = new URL(req.url).searchParams.get('status') ?? undefined;

  const employees = await prisma.employeePayment.findMany({
    where: {
      runId: ctx.params.id,
      ...(status ? { status: status as 'QUEUED' | 'EXCLUDED' | 'EXECUTING' | 'SETTLED' | 'FAILED' } : {}),
    },
    orderBy: [{ status: 'asc' }, { employeeName: 'asc' }],
    select: {
      id: true,
      employeeRef: true,
      employeeName: true,
      country: true,
      currency: true,
      netAmount: true,
      status: true,
      transactionRef: true,
      settledAt: true,
      failureReason: true,
    },
  });

  return NextResponse.json({ employees });
}
