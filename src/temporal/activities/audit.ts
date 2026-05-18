import { prisma } from '../../lib/prisma';
import type { Prisma } from '@prisma/client';

/**
 * Audit + run-lifecycle state changes.
 *
 * Anything that mutates the canonical state of a run lives here. The
 * workflow code never touches the DB directly — it goes through these
 * activities so every transition is replay-safe and observable.
 */

export async function audit(args: {
  runId: string;
  stage?: string;
  eventType: string;
  payload: Record<string, unknown>;
  actor?: string;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      runId: args.runId,
      stage: (args.stage as Prisma.AuditEventCreateInput['stage']) ?? null,
      eventType: args.eventType,
      actor: args.actor ?? 'system',
      payload: args.payload as never,
    },
  });
}

export async function setStage(args: {
  runId: string;
  stage:
    | 'INGEST'
    | 'RECONCILE'
    | 'APPROVAL'
    | 'FUND'
    | 'EXECUTE'
    | 'CONFIRM';
}): Promise<void> {
  await prisma.payrollRun.update({
    where: { id: args.runId },
    data: {
      currentStage: args.stage,
      startedAt: { set: undefined } as never,        // preserve first set
    },
  });
}

export async function markRunStatus(args: {
  runId: string;
  status: 'RUNNING' | 'AWAITING_APPROVAL' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
}): Promise<void> {
  await prisma.payrollRun.update({
    where: { id: args.runId },
    data: {
      status: args.status,
      completedAt:
        args.status === 'COMPLETED' || args.status === 'FAILED' || args.status === 'CANCELLED'
          ? new Date()
          : null,
    },
  });
}
