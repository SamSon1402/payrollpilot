import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getTemporalClient } from '@/lib/temporal-client';

/**
 * POST /api/payroll-runs/[id]/approve
 *
 * Deliver the approver's decision to the paused workflow.
 *
 * Same dual-write pattern as WorkflowForge: DB first (system of record
 * for compliance) then Temporal signal (resumes the workflow). If the
 * signal fails — the workflow already timed out or the cluster is
 * unreachable — we still have a record of who decided what and when.
 *
 *   curl -X POST http://localhost:3000/api/payroll-runs/<id>/approve \
 *     -H "content-type: application/json" \
 *     -d '{"decision":"APPROVED","approverId":"u_hof_david","reason":"CFO OOO; approving per delegate policy"}'
 */

export const runtime = 'nodejs';

const Body = z.object({
  decision:   z.enum(['APPROVED', 'REJECTED']),
  approverId: z.string(),
  reason:     z.string().max(500).optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } }
): Promise<NextResponse> {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { decision, approverId, reason } = parsed.data;

  const pending = await prisma.approval.findFirst({
    where: { runId: ctx.params.id, decision: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!pending) {
    return NextResponse.json({ error: 'no_pending_approval' }, { status: 409 });
  }

  // 1) DB write — canonical record
  await prisma.approval.update({
    where: { id: pending.id },
    data: {
      decision,
      decidedAt: new Date(),
      resolvedApprover: approverId,
      reason: reason ?? null,
    },
  });

  // 2) Signal Temporal
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(`payroll-${ctx.params.id}`);
  try {
    await handle.signal('approval', { decision, approverId, reason });
  } catch (err) {
    console.error('temporal.signal.failed', err);
    return NextResponse.json(
      { ok: false, warning: 'workflow_no_longer_running' },
      { status: 202 }
    );
  }

  return NextResponse.json({ ok: true });
}
