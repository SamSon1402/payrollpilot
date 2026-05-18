import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  startChild,
  ParentClosePolicy,
  log,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import { employeePaymentWorkflow } from './employee-payment';

/**
 * Parent payroll workflow — the 6-stage pipeline.
 *
 *   INGEST → RECONCILE → APPROVAL → FUND → EXECUTE → CONFIRM
 *
 * Three rules govern the design:
 *
 *   1. Side effects only inside activities (determinism — Temporal must
 *      be able to replay this from history without rerunning a Plaid
 *      call or rolling a different random number).
 *
 *   2. Exceptions are routed, not thrown. Anything anticipated
 *      (missing IBAN, low treasury, approver OOO) becomes a typed
 *      Exception row in the DB and pauses the workflow on a signal.
 *      Activity-level throws are reserved for truly unexpected failures
 *      and propagate through Temporal's retry policy.
 *
 *   3. EXECUTE fans out to per-employee child workflows. A failure in
 *      one employee's payment doesn't roll back the other 27 — child
 *      workflows isolate failure radius. The parent waits for all
 *      children and aggregates.
 */

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '1s',
    maximumInterval: '1m',
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

// ---- Signals & queries ---------------------------------------------------

// Sent by POST /api/payroll-runs/[id]/approve. Resolved approver is
// included so the audit log captures who actually approved (delegate or
// the original requested role).
export interface ApprovalDecisionSignal {
  decision: 'APPROVED' | 'REJECTED';
  approverId: string;
  reason?: string;
}
export const approvalSignal = defineSignal<[ApprovalDecisionSignal]>('approval');

// Sent by POST /api/payroll-runs/[id]/exceptions/[exId]/resolve. The
// resolution is opaque to the workflow — it tells the workflow "this
// exception is handled, continue" and any state mutation already
// happened in the resolution activity.
export interface ExceptionResolutionSignal {
  exceptionId: string;
  resolvedBy: string;
}
export const exceptionResolvedSignal =
  defineSignal<[ExceptionResolutionSignal]>('exceptionResolved');

// Cancellation is rare but the UX needs the button.
export const cancelSignal = defineSignal<[]>('cancel');

// Query for the UI: which stage are we in right now? Cheaper than
// polling the DB on every render.
export const stageQuery = defineQuery<string>('currentStage');

// ---- Workflow input/output -----------------------------------------------

export interface PayrollRunInput {
  runId: string;          // our DB row id
}

export interface PayrollRunResult {
  status: 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'FAILED';
  employeesPaid: number;
  employeesExcluded: number;
  employeesFailed: number;
  totalPaidMinorUnits: number;
}

// ---- Workflow body -------------------------------------------------------

export async function payrollRunWorkflow(
  input: PayrollRunInput,
): Promise<PayrollRunResult> {
  const { runId } = input;
  log.info('payroll.start', { runId });

  // Local state. The interpreter keeps a snapshot here and writes
  // canonical state changes through activities.
  let currentStage: string = 'INGEST';
  let cancelled = false;
  const resolvedExceptions = new Set<string>();
  let approval: ApprovalDecisionSignal | undefined;

  setHandler(stageQuery, () => currentStage);
  setHandler(cancelSignal, () => { cancelled = true; });
  setHandler(approvalSignal, (payload) => { approval = payload; });
  setHandler(exceptionResolvedSignal, ({ exceptionId }) => {
    resolvedExceptions.add(exceptionId);
  });

  const checkCancellation = (): void => {
    if (cancelled) {
      throw new Error('payroll run cancelled by user');
    }
  };

  await acts.audit({ runId, eventType: 'RUN_STARTED', payload: {} });

  // -------- STAGE 1: INGEST -----------------------------------------------
  currentStage = 'INGEST';
  await acts.setStage({ runId, stage: 'INGEST' });
  const ingested = await acts.ingestFromHris({ runId });
  await acts.audit({
    runId,
    stage: 'INGEST',
    eventType: 'STAGE_DONE',
    payload: { employeeCount: ingested.employeeCount, total: ingested.total },
  });

  // -------- STAGE 2: RECONCILE -------------------------------------------
  // IBAN validation and balance pre-check. Missing-IBAN employees get
  // excluded from this run (they'll be paid next cycle) so a single
  // data problem doesn't block 27 other people getting their salary.
  currentStage = 'RECONCILE';
  await acts.setStage({ runId, stage: 'RECONCILE' });
  const reconciliation = await acts.reconcile({ runId });

  for (const ex of reconciliation.exceptions) {
    checkCancellation();
    await waitForExceptionResolution(ex.id, resolvedExceptions);
  }
  await acts.audit({
    runId,
    stage: 'RECONCILE',
    eventType: 'STAGE_DONE',
    payload: {
      excludedCount: reconciliation.excludedCount,
      validCount: reconciliation.validCount,
    },
  });

  // -------- STAGE 3: APPROVAL --------------------------------------------
  currentStage = 'APPROVAL';
  await acts.setStage({ runId, stage: 'APPROVAL' });
  const approvalRequest = await acts.requestApproval({ runId });

  if (approvalRequest.kind === 'auto_approved') {
    // Below auto-approve threshold (e.g. < £50k) — proceed without a gate.
    await acts.audit({
      runId,
      stage: 'APPROVAL',
      eventType: 'AUTO_APPROVED',
      payload: { total: approvalRequest.total },
    });
  } else {
    // Wait for the approval signal up to the SLA window. If the approver
    // chain was exhausted at request-time, an APPROVER_UNAVAILABLE
    // exception was created — wait for that to resolve first.
    if (approvalRequest.exceptionId) {
      await waitForExceptionResolution(
        approvalRequest.exceptionId,
        resolvedExceptions,
      );
    }

    const slaMs = approvalRequest.slaHours * 3_600_000;
    const got = await condition(() => approval !== undefined, slaMs);
    if (!got) {
      await acts.markRunStatus({ runId, status: 'FAILED' });
      await acts.audit({
        runId,
        stage: 'APPROVAL',
        eventType: 'APPROVAL_TIMED_OUT',
        payload: { slaHours: approvalRequest.slaHours },
      });
      throw new Error('approval SLA exceeded');
    }

    if (approval!.decision === 'REJECTED') {
      await acts.markRunStatus({ runId, status: 'CANCELLED' });
      await acts.audit({
        runId,
        stage: 'APPROVAL',
        eventType: 'REJECTED',
        payload: { approverId: approval!.approverId, reason: approval!.reason },
      });
      return {
        status: 'REJECTED',
        employeesPaid: 0,
        employeesExcluded: reconciliation.excludedCount,
        employeesFailed: 0,
        totalPaidMinorUnits: 0,
      };
    }

    await acts.recordApprovalDecision({
      runId,
      approverId: approval!.approverId,
      reason: approval!.reason,
    });
  }

  // -------- STAGE 4: FUND ------------------------------------------------
  // Check treasury, sweep from MMF if needed, lock FX rates.
  currentStage = 'FUND';
  await acts.setStage({ runId, stage: 'FUND' });
  const funding = await acts.fundRun({ runId });

  if (funding.exceptionId) {
    checkCancellation();
    await waitForExceptionResolution(funding.exceptionId, resolvedExceptions);
    // Re-run funding now that the exception is resolved (e.g. MMF
    // sweep completed). Idempotent on the activity side.
    await acts.fundRun({ runId });
  }

  await acts.audit({
    runId,
    stage: 'FUND',
    eventType: 'STAGE_DONE',
    payload: { fundedTotal: funding.fundedTotal },
  });

  // -------- STAGE 5: EXECUTE ---------------------------------------------
  // Fan-out: one child workflow per employee. Each child carries its
  // own idempotency key — the bank-side dedup is the safety net,
  // Temporal's at-least-once retries are the lever.
  currentStage = 'EXECUTE';
  await acts.setStage({ runId, stage: 'EXECUTE' });
  const employees = await acts.listPayableEmployees({ runId });

  const childHandles = await Promise.all(
    employees.map((emp) =>
      startChild(employeePaymentWorkflow, {
        args: [{ paymentId: emp.id, runId }],
        workflowId: `payment-${emp.id}`,
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
      }),
    ),
  );

  // Wait for every child to settle (success or failure). We use
  // `allSettled` semantics: one employee's payment failing must NOT
  // cancel the others. Aggregation comes from the DB at CONFIRM time.
  const results = await Promise.allSettled(childHandles.map((h) => h.result()));
  const settledCount = results.filter((r) => r.status === 'fulfilled').length;
  const failedCount = results.length - settledCount;

  await acts.audit({
    runId,
    stage: 'EXECUTE',
    eventType: 'STAGE_DONE',
    payload: { settledCount, failedCount },
  });

  // -------- STAGE 6: CONFIRM ---------------------------------------------
  currentStage = 'CONFIRM';
  await acts.setStage({ runId, stage: 'CONFIRM' });
  const summary = await acts.finalizeRun({ runId });

  await acts.audit({
    runId,
    stage: 'CONFIRM',
    eventType: 'RUN_COMPLETED',
    payload: summary,
  });

  return {
    status: 'COMPLETED',
    employeesPaid: summary.paidCount,
    employeesExcluded: summary.excludedCount,
    employeesFailed: summary.failedCount,
    totalPaidMinorUnits: summary.totalPaidMinorUnits,
  };
}

/**
 * Block until an exception is resolved. The /resolve API route signals
 * the workflow with the exception id, and we wake up here.
 *
 * No artificial timeout — these are human-in-the-loop resolutions.
 * Temporal happily keeps the workflow paused for hours or days, and
 * the worker can restart underneath us without losing state.
 */
async function waitForExceptionResolution(
  exceptionId: string,
  resolvedSet: Set<string>,
): Promise<void> {
  await condition(() => resolvedSet.has(exceptionId));
}
