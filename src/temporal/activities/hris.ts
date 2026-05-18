import { prisma } from '../../lib/prisma';
import { paymentIdempotencyKey } from '../../lib/idempotency';

/**
 * HRIS ingestion — pulls payslips from PayFit / Deel / Pento and
 * lands them as EmployeePayment rows.
 *
 * Production note: this should be incremental. The HRIS gives us a
 * `runRef` per pay-period; on re-ingest we upsert by (runId, employeeRef)
 * so a partial failure followed by retry doesn't duplicate rows. The
 * idempotency key derived here is what makes the bank-side dedup work
 * later — same employee + same amount = same key, every retry.
 */

export interface IngestResult {
  employeeCount: number;
  total: number;
  currency: string;
}

export async function ingestFromHris(args: { runId: string }): Promise<IngestResult> {
  const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: args.runId } });

  // TODO: real PayFit / Deel client
  //   const payfit = new PayFitClient({ apiKey: process.env.PAYFIT_API_KEY });
  //   const period = { from: run.periodStart, to: run.periodEnd };
  //   const payslips = await payfit.payslips.list({ companyId, period });
  const payslips = await fetchPayslipsStub();

  // Upsert by (runId, employeeRef) — safe to call this activity twice.
  for (const p of payslips) {
    const idempotencyKey = paymentIdempotencyKey({
      runId: args.runId,
      employeeRef: p.employeeRef,
      netAmount: p.netAmount,
      currency: p.currency,
    });

    await prisma.employeePayment.upsert({
      where: { idempotencyKey },
      create: {
        runId: args.runId,
        employeeRef: p.employeeRef,
        employeeName: p.employeeName,
        iban: p.iban ?? null,
        bic: p.bic ?? null,
        country: p.country,
        currency: p.currency,
        grossAmount: p.grossAmount,
        netAmount: p.netAmount,
        idempotencyKey,
      },
      update: {},
    });
  }

  const total = payslips.reduce((s, p) => s + p.netAmount, 0);
  await prisma.payrollRun.update({
    where: { id: args.runId },
    data: { expectedTotal: total },
  });

  return { employeeCount: payslips.length, total, currency: run.currency };
}

interface PayslipDto {
  employeeRef: string;
  employeeName: string;
  iban: string | null;
  bic: string | null;
  country: string;
  currency: string;
  grossAmount: number;
  netAmount: number;
}

// Stub data — the shape mirrors what the PayFit API actually returns.
async function fetchPayslipsStub(): Promise<PayslipDto[]> {
  return [
    { employeeRef: 'e001', employeeName: 'Aisha Patel',   iban: 'GB29NWBK60161331926819', bic: 'NWBKGB2L', country: 'GB', currency: 'GBP', grossAmount: 7850,  netAmount: 5612 },
    { employeeRef: 'e002', employeeName: 'Marcus Chen',   iban: 'GB82WEST12345698765432', bic: 'WESTGB2L', country: 'GB', currency: 'GBP', grossAmount: 8200,  netAmount: 5800 },
    { employeeRef: 'e003', employeeName: 'Sofia Romano',  iban: null,                    bic: null,       country: 'IT', currency: 'EUR', grossAmount: 6400,  netAmount: 4480 },
    { employeeRef: 'e004', employeeName: 'Liam Walsh',    iban: 'IE29AIBK93115212345678', bic: 'AIBKIE2D', country: 'IE', currency: 'EUR', grossAmount: 7200,  netAmount: 5040 },
    { employeeRef: 'e005', employeeName: 'Yuki Tanaka',   iban: 'GB94BARC10201530093459', bic: 'BARCGB22', country: 'GB', currency: 'GBP', grossAmount: 9100,  netAmount: 6370 },
    // ... in production, all 28
  ];
}
