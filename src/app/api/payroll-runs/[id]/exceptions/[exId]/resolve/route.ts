import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getTemporalClient } from '@/lib/temporal-client';
import { sweepFromMmfToOperating } from '@/temporal/activities/treasury';
import { ExceptionPayload } from '@/lib/types';

/**
 * POST /api/payroll-runs/[id]/exceptions/[exId]/resolve
 *
 * Resolve an exception so the workflow can proceed. Each ExceptionType
 * has a typed resolution path — the API enforces that the resolution
 * action matches the exception kind. This stops e.g. the UI from
 * trying to "auto-sweep" a missing-IBAN exception.
 *
 *   curl -X POST http://localhost:3000/api/payroll-runs/<runId>/exceptions/<exId>/resolve \
 *     -H "content-type: application/json" \
 *     -d '{"action":"AUTO","resolvedBy":"u_admin"}'
 *
 *   # For approver-OOO with a manually chosen delegate:
 *   curl ... -d '{"action":"DELEGATE","resolvedBy":"u_admin","delegateUserId":"u_hof_david"}'
 */

export const runtime = 'nodejs';

const Body = z.object({
  action: z.enum(['AUTO', 'DELEGATE', 'EXCLUDE', 'MANUAL']),
  resolvedBy: z.string(),
  delegateUserId: z.string().optional(),
  note: z.string().max(500).optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string; exId: string } }
): Promise<NextResponse> {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { action, resolvedBy, delegateUserId, note } = parsed.data;

  const exception = await prisma.exception.findUnique({
    where: { id: ctx.params.exId },
  });
  if (!exception || exception.runId !== ctx.params.id) {
    return NextResponse.json({ error: 'exception_not_found' }, { status: 404 });
  }
  if (exception.state === 'AUTO_RESOLVED' || exception.state === 'MANUAL_RESOLVED') {
    return NextResponse.json({ error: 'already_resolved' }, { status: 409 });
  }

  // Validate that the action matches the exception type.
  const payload = ExceptionPayload.parse(exception.payload);
  const allowed = ALLOWED_ACTIONS[payload.type];
  if (!allowed.includes(action)) {
    return NextResponse.json(
      { error: 'invalid_action_for_exception_type',
        exceptionType: payload.type, allowed },
      { status: 400 }
    );
  }

  // Perform the resolution side-effect (if any).
  let resolution: Record<string, unknown> = { action, note };
  switch (action) {
    case 'AUTO':
      if (payload.type === 'INSUFFICIENT_TREASURY') {
        // Trigger an MMF sweep for the exact shortfall.
        const result = await sweepFromMmfToOperating({
          runId: exception.runId,
          amount: payload.shortfall,
        });
        resolution = { ...resolution, sweep: result };
      }
      break;
    case 'DELEGATE':
      if (!delegateUserId) {
        return NextResponse.json({ error: 'delegate_userId_required' }, { status: 400 });
      }
      resolution = { ...resolution, delegateUserId };
      break;
    case 'EXCLUDE':
      // Already handled at reconcile time — this just acknowledges the
      // exception so the workflow can continue.
      break;
    case 'MANUAL':
      // Operator says they've handled it out-of-band (e.g. fixed IBAN
      // in PayFit and re-ingested).
      break;
  }

  // Persist resolution + flip state.
  const resolvedState = action === 'AUTO' ? 'AUTO_RESOLVED' : 'MANUAL_RESOLVED';
  await prisma.exception.update({
    where: { id: exception.id },
    data: {
      state: resolvedState,
      resolvedAt: new Date(),
      resolvedBy,
      resolution: resolution as never,
    },
  });

  // Signal the workflow so it can resume.
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(`payroll-${exception.runId}`);
  try {
    await handle.signal('exceptionResolved', {
      exceptionId: exception.id,
      resolvedBy,
    });
  } catch (err) {
    console.error('temporal.signal.failed', err);
    return NextResponse.json(
      { ok: false, warning: 'workflow_no_longer_running' },
      { status: 202 }
    );
  }

  return NextResponse.json({ ok: true, state: resolvedState });
}

/**
 * Exception-type → allowed-action policy. Keeping it as a typed table
 * here means a new exception type forces the team to declare what
 * actions are valid for it.
 */
const ALLOWED_ACTIONS: Record<ExceptionPayload['type'], Array<'AUTO' | 'DELEGATE' | 'EXCLUDE' | 'MANUAL'>> = {
  MISSING_IBAN:             ['EXCLUDE', 'MANUAL'],
  INVALID_IBAN:             ['EXCLUDE', 'MANUAL'],
  APPROVER_UNAVAILABLE:     ['DELEGATE', 'MANUAL'],
  INSUFFICIENT_TREASURY:    ['AUTO', 'MANUAL'],
  HRIS_FETCH_FAILED:        ['MANUAL'],
  PAYMENT_REJECTED_BY_BANK: ['MANUAL'],
  FX_RATE_STALE:            ['AUTO', 'MANUAL'],
};
