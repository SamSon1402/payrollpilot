import { z } from 'zod';

/**
 * Shared types.
 *
 * The most important thing here is `ExceptionPayload` — a Zod
 * discriminated union, one variant per ExceptionType. Code that handles
 * exceptions can `switch` on `payload.type` and the compiler enforces
 * exhaustiveness. This is the alternative to having free-form `error`
 * strings everywhere, which is what most "we'll handle it later" payroll
 * systems end up with.
 */

export const MissingIbanPayload = z.object({
  type: z.literal('MISSING_IBAN'),
  employeeRef: z.string(),
  employeeName: z.string(),
  country: z.string(),
});

export const InvalidIbanPayload = z.object({
  type: z.literal('INVALID_IBAN'),
  employeeRef: z.string(),
  iban: z.string(),
  ibanToolsError: z.string(),
});

export const ApproverUnavailablePayload = z.object({
  type: z.literal('APPROVER_UNAVAILABLE'),
  requestedRole: z.string(),
  reason: z.enum(['OOO', 'NO_RESPONSE_WITHIN_SLA', 'OFFBOARDED']),
  attemptedChain: z.array(z.string()),
});

export const InsufficientTreasuryPayload = z.object({
  type: z.literal('INSUFFICIENT_TREASURY'),
  required: z.number(),
  available: z.number(),
  shortfall: z.number(),
  currency: z.string(),
  suggestedSource: z.enum(['MMF_SWEEP', 'FX_SWAP', 'MANUAL']),
});

export const HrisFetchFailedPayload = z.object({
  type: z.literal('HRIS_FETCH_FAILED'),
  provider: z.string(),
  httpStatus: z.number().optional(),
  message: z.string(),
});

export const PaymentRejectedPayload = z.object({
  type: z.literal('PAYMENT_REJECTED_BY_BANK'),
  employeeRef: z.string(),
  bankCode: z.string(),
  bankMessage: z.string(),
});

export const FxRateStalePayload = z.object({
  type: z.literal('FX_RATE_STALE'),
  pair: z.string(),
  rateAgeSeconds: z.number(),
  maxAgeSeconds: z.number(),
});

export const ExceptionPayload = z.discriminatedUnion('type', [
  MissingIbanPayload,
  InvalidIbanPayload,
  ApproverUnavailablePayload,
  InsufficientTreasuryPayload,
  HrisFetchFailedPayload,
  PaymentRejectedPayload,
  FxRateStalePayload,
]);
export type ExceptionPayload = z.infer<typeof ExceptionPayload>;

/**
 * Stage ordering — single source of truth so the workflow, API and UI
 * agree on what "next stage" means.
 */
export const PAYROLL_STAGES = [
  'INGEST',
  'RECONCILE',
  'APPROVAL',
  'FUND',
  'EXECUTE',
  'CONFIRM',
] as const;
export type PayrollStage = (typeof PAYROLL_STAGES)[number];

export function nextStage(current: PayrollStage): PayrollStage | null {
  const i = PAYROLL_STAGES.indexOf(current);
  return PAYROLL_STAGES[i + 1] ?? null;
}
