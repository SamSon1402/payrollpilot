import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getTemporalClient, TASK_QUEUE } from '@/lib/temporal-client';

/**
 * POST /api/payroll-runs
 *
 * Create a payroll run and start the Temporal workflow that drives it
 * through the 6-stage pipeline.
 *
 *   curl -X POST http://localhost:3000/api/payroll-runs \
 *     -H "content-type: application/json" \
 *     -d '{
 *       "periodStart": "2026-05-01",
 *       "periodEnd":   "2026-05-31",
 *       "payDate":     "2026-05-28",
 *       "currency":    "GBP",
 *       "triggeredBy": "u_demo"
 *     }'
 */

export const runtime = 'nodejs';

const Body = z.object({
  periodStart: z.coerce.date(),
  periodEnd:   z.coerce.date(),
  payDate:     z.coerce.date(),
  currency:    z.string().length(3).default('GBP'),
  triggeredBy: z.string(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const body = parsed.data;

  // Create the run row first — its id is the runId we pass to Temporal.
  const run = await prisma.payrollRun.create({
    data: {
      periodStart: body.periodStart,
      periodEnd:   body.periodEnd,
      payDate:     body.payDate,
      currency:    body.currency,
      triggeredBy: body.triggeredBy,
      status:      'RUNNING',
      startedAt:   new Date(),
    },
  });

  // Start the Temporal workflow. workflowId is deterministic per run,
  // so Temporal itself becomes our duplicate-start guard.
  const client = await getTemporalClient();
  let handle;
  try {
    handle = await client.workflow.start('payrollRunWorkflow', {
      args: [{ runId: run.id }],
      taskQueue: TASK_QUEUE,
      workflowId: `payroll-${run.id}`,
    });
  } catch (err) {
    await prisma.payrollRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    console.error('temporal.start.failed', err);
    return NextResponse.json({ error: 'temporal_start_failed' }, { status: 502 });
  }

  await prisma.payrollRun.update({
    where: { id: run.id },
    data: { temporalRunId: handle.firstExecutionRunId },
  });

  return NextResponse.json({
    runId: run.id,
    temporalWorkflowId: handle.workflowId,
    status: 'RUNNING',
  }, { status: 202 });
}
