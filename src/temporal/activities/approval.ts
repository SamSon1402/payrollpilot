import { prisma } from '../../lib/prisma';
import {
  resolveApprover,
  ApproverChainExhaustedError,
  type ApproverAvailability,
  type ApproverRole,
} from '../../lib/delegate-chain';
import type { ExceptionPayload } from '../../lib/types';

/**
 * Request approval for the run.
 *
 * Walks the delegate chain at request-time, picks the highest-priority
 * available approver, and writes the Approval row. Returns either:
 *   • `auto_approved`   — below the auto-approve threshold, no gate
 *   • `pending`         — gate created, workflow should wait for signal
 *   • `pending` + exceptionId — chain exhausted, exception created and
 *                                must be resolved before we can proceed
 */

const AUTO_APPROVE_THRESHOLD_GBP = 50_000;

export type ApprovalRequestResult =
  | { kind: 'auto_approved'; total: number }
  | { kind: 'pending'; approvalId: string; slaHours: number; exceptionId?: string };

export async function requestApproval(args: { runId: string }): Promise<ApprovalRequestResult> {
  const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: args.runId } });
  const total = Number(run.expectedTotal ?? 0);

  if (total < AUTO_APPROVE_THRESHOLD_GBP) {
    return { kind: 'auto_approved', total };
  }

  const requestedRole: ApproverRole = 'CFO';
  await prisma.payrollRun.update({
    where: { id: args.runId },
    data: { status: 'AWAITING_APPROVAL' },
  });

  // TODO: real availability lookup against Google Calendar + Slack
  //   const availabilities = await fetchAvailability(organizationId);
  const availabilities = await fetchAvailabilityStub();

  try {
    const resolved = resolveApprover(requestedRole, availabilities);
    const approval = await prisma.approval.create({
      data: {
        runId: args.runId,
        requestedRole,
        resolvedApprover: resolved.userId,
        slaHours: resolved.isDelegate ? 2 : 4,    // tighter SLA on delegate
      },
    });
    return { kind: 'pending', approvalId: approval.id, slaHours: approval.slaHours };
  } catch (err) {
    if (!(err instanceof ApproverChainExhaustedError)) throw err;

    const payload: ExceptionPayload = {
      type: 'APPROVER_UNAVAILABLE',
      requestedRole: err.requestedRole,
      reason: 'OOO',
      attemptedChain: err.attempted,
    };
    const ex = await prisma.exception.create({
      data: {
        runId: args.runId,
        type: 'APPROVER_UNAVAILABLE',
        state: 'PENDING_RESOLUTION',
        detectedAtStage: 'APPROVAL',
        payload: payload as never,
      },
    });
    const approval = await prisma.approval.create({
      data: {
        runId: args.runId,
        requestedRole,
        slaHours: 4,
      },
    });
    return {
      kind: 'pending',
      approvalId: approval.id,
      slaHours: 4,
      exceptionId: ex.id,
    };
  }
}

/**
 * Record the resolution of the approval (called after the workflow
 * receives the approval signal from the /approve API).
 */
export async function recordApprovalDecision(args: {
  runId: string;
  approverId: string;
  reason?: string;
}): Promise<void> {
  await prisma.approval.updateMany({
    where: { runId: args.runId, decision: null },
    data: {
      decision: 'APPROVED',
      decidedAt: new Date(),
      resolvedApprover: args.approverId,
      reason: args.reason ?? null,
    },
  });
}

async function fetchAvailabilityStub(): Promise<ApproverAvailability[]> {
  return [
    { role: 'CFO',                userId: 'u_cfo_jane',     available: false, reason: 'OOO' },
    { role: 'HEAD_OF_FINANCE',    userId: 'u_hof_david',    available: true },
    { role: 'FINANCE_CONTROLLER', userId: 'u_fc_priya',     available: true },
    { role: 'CEO',                userId: 'u_ceo_emma',     available: true },
    { role: 'TREASURER',          userId: 'u_treas_marcus', available: true },
  ];
}
