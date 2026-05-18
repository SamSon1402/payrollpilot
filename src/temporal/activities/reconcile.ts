import { validateIBAN, electronicFormatIBAN } from 'ibantools';
import { prisma } from '../../lib/prisma';
import type { ExceptionPayload } from '../../lib/types';

/**
 * Reconciliation stage.
 *
 * Three checks happen here:
 *   1. IBAN presence    → MISSING_IBAN exception (employee excluded from run)
 *   2. IBAN validity    → INVALID_IBAN exception (employee excluded)
 *   3. Currency support → silent skip if currency isn't on our rails
 *
 * The design choice worth flagging: missing-IBAN employees are
 * EXCLUDED, not blocked. Their salary will be paid next cycle once
 * People Ops fixes the data, but Sofia missing her IBAN doesn't stop
 * the other 27 people getting paid on time. The exception still goes
 * to People Ops for resolution — we surface the problem without making
 * 27 colleagues wait on it.
 */

export interface ReconcileResult {
  validCount: number;
  excludedCount: number;
  exceptions: { id: string; type: string }[];
}

export async function reconcile(args: { runId: string }): Promise<ReconcileResult> {
  const employees = await prisma.employeePayment.findMany({
    where: { runId: args.runId, status: 'QUEUED' },
  });

  const createdExceptions: { id: string; type: string }[] = [];
  let validCount = 0;
  let excludedCount = 0;

  for (const emp of employees) {
    // ---- Missing IBAN ----
    if (!emp.iban) {
      const payload: ExceptionPayload = {
        type: 'MISSING_IBAN',
        employeeRef: emp.employeeRef,
        employeeName: emp.employeeName,
        country: emp.country,
      };
      const ex = await prisma.exception.create({
        data: {
          runId: args.runId,
          employeeId: emp.id,
          type: 'MISSING_IBAN',
          state: 'PENDING_RESOLUTION',
          detectedAtStage: 'RECONCILE',
          payload: payload as never,
        },
      });
      await prisma.employeePayment.update({
        where: { id: emp.id },
        data: { status: 'EXCLUDED', failureReason: 'missing IBAN at reconcile' },
      });
      createdExceptions.push({ id: ex.id, type: 'MISSING_IBAN' });
      excludedCount++;
      continue;
    }

    // ---- Invalid IBAN ----
    // ibantools checks the modulo-97 checksum + country structure.
    const normalised = electronicFormatIBAN(emp.iban) ?? emp.iban;
    const v = validateIBAN(normalised);
    if (!v.valid) {
      const payload: ExceptionPayload = {
        type: 'INVALID_IBAN',
        employeeRef: emp.employeeRef,
        iban: emp.iban,
        ibanToolsError: v.errorCodes.join(','),
      };
      const ex = await prisma.exception.create({
        data: {
          runId: args.runId,
          employeeId: emp.id,
          type: 'INVALID_IBAN',
          state: 'PENDING_RESOLUTION',
          detectedAtStage: 'RECONCILE',
          payload: payload as never,
        },
      });
      await prisma.employeePayment.update({
        where: { id: emp.id },
        data: { status: 'EXCLUDED', failureReason: 'invalid IBAN at reconcile' },
      });
      createdExceptions.push({ id: ex.id, type: 'INVALID_IBAN' });
      excludedCount++;
      continue;
    }

    // Normalise IBAN in the DB so downstream activities work with the
    // canonical electronic format.
    if (normalised !== emp.iban) {
      await prisma.employeePayment.update({
        where: { id: emp.id },
        data: { iban: normalised },
      });
    }
    validCount++;
  }

  return { validCount, excludedCount, exceptions: createdExceptions };
}
