import { inngest } from './client';
import { prisma } from '../lib/prisma';
import { getTemporalClient, TASK_QUEUE } from '../lib/temporal-client';

/**
 * Payroll-scheduler.
 *
 * Inngest's job here is to wake up and decide "is today the day to
 * START a new payroll run?" — typically 3 business days before pay
 * date so funding has time to settle. Temporal then drives the run
 * itself.
 *
 * Two functions:
 *   - scheduler  → fires daily at 09:00 UK time, checks the schedule
 *                  table, starts a run if one is due
 *   - manualTrigger → fan-in for "run payroll for org X NOW" event,
 *                     used by the dashboard "Start now" button
 */

export const scheduler = inngest.createFunction(
  { id: 'payroll-scheduler' },
  { cron: 'TZ=Europe/London 0 9 * * *' },
  async ({ step }) => {
    const due = await step.run('find-due-payrolls', async () => {
      // TODO: real schedule table per organisation
      //   return prisma.payrollSchedule.findMany({ where: { nextRunDate: today } });
      return [] as Array<{
        orgId: string;
        periodStart: Date;
        periodEnd: Date;
        payDate: Date;
        currency: string;
      }>;
    });

    for (const schedule of due) {
      await step.run(`start-${schedule.orgId}`, async () => {
        const run = await prisma.payrollRun.create({
          data: {
            periodStart: schedule.periodStart,
            periodEnd:   schedule.periodEnd,
            payDate:     schedule.payDate,
            currency:    schedule.currency,
            triggeredBy: 'inngest:scheduler',
            status:      'RUNNING',
            startedAt:   new Date(),
          },
        });
        const client = await getTemporalClient();
        const handle = await client.workflow.start('payrollRunWorkflow', {
          args: [{ runId: run.id }],
          taskQueue: TASK_QUEUE,
          workflowId: `payroll-${run.id}`,
        });
        await prisma.payrollRun.update({
          where: { id: run.id },
          data: { temporalRunId: handle.firstExecutionRunId },
        });
      });
    }

    return { started: due.length };
  }
);

export const manualTrigger = inngest.createFunction(
  { id: 'payroll-manual-trigger' },
  { event: 'payroll/run.requested' },
  async ({ event, step }) => {
    const payload = event.data as {
      periodStart: string;
      periodEnd: string;
      payDate: string;
      currency: string;
      triggeredBy: string;
    };
    return step.run('start', async () => {
      const run = await prisma.payrollRun.create({
        data: {
          periodStart: new Date(payload.periodStart),
          periodEnd:   new Date(payload.periodEnd),
          payDate:     new Date(payload.payDate),
          currency:    payload.currency,
          triggeredBy: payload.triggeredBy,
          status:      'RUNNING',
          startedAt:   new Date(),
        },
      });
      const client = await getTemporalClient();
      const handle = await client.workflow.start('payrollRunWorkflow', {
        args: [{ runId: run.id }],
        taskQueue: TASK_QUEUE,
        workflowId: `payroll-${run.id}`,
      });
      await prisma.payrollRun.update({
        where: { id: run.id },
        data: { temporalRunId: handle.firstExecutionRunId },
      });
      return { runId: run.id };
    });
  }
);
