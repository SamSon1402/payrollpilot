# PayrollPilot

Autonomous payroll execution with first-class exception handling.

The happy path — pull payslips, fund the account, send a SEPA batch — is the easy 80%. PayrollPilot is built around the other 20%: missing IBANs, OOO approvers, low treasury, bank rejections. Every one of those is a typed exception with a typed resolution path, not a free-form error.

Built as a demo for the Round Treasury Founding Product Engineer role.
Stack matches the JD: **Next.js · TypeScript · Prisma · PostgreSQL · Temporal · Inngest**.

---

## The 6-stage pipeline

```
   INGEST  ──►  RECONCILE  ──►  APPROVAL  ──►  FUND  ──►  EXECUTE  ──►  CONFIRM
     │             │              │             │           │              │
     │             ▼              ▼             ▼           ▼              ▼
   PayFit/      IBAN check   Delegate-     Treasury     1 child wf      Aggregate +
   Deel         + balance    chain         check +      per employee    audit seal
   payslips     pre-check    walk          MMF sweep    (Promise.all
                                                         Settled)

                Exceptions: typed, routable, resolvable per stage
```

A parent Temporal workflow (`payrollRunWorkflow`) drives the 6 stages. EXECUTE fans out to one child workflow per employee (`employeePaymentWorkflow`) so a single bad IBAN can't cancel 27 other salaries.

---

## What's in the box

| File | What it does |
|---|---|
| `prisma/schema.prisma` | Data model. Exception is a first-class entity with a typed state machine (`DETECTED → PENDING → AUTO_RESOLVED \| MANUAL_RESOLVED \| ESCALATED`). |
| `src/lib/types.ts` | `ExceptionPayload` as a Zod discriminated union — one variant per exception type, compiler-enforced exhaustiveness. |
| `src/lib/delegate-chain.ts` | Approver delegate chains (`CFO → HEAD_OF_FINANCE → CEO`). Pure function, fails closed when chain exhausted. |
| `src/lib/idempotency.ts` | Deterministic `(run, employee, amount)` → idempotency key. The thing that makes Temporal's at-least-once activity retries safe at the payment layer. |
| `src/temporal/workflows/payroll-run.ts` | The 6-stage parent workflow. Exceptions routed through signals, no try/catch theatre. |
| `src/temporal/workflows/employee-payment.ts` | Per-employee child workflow. Isolates failure radius. Non-retryable bank errors marked explicitly. |
| `src/temporal/activities/*.ts` | Activities split by domain: `audit`, `hris`, `reconcile`, `approval`, `treasury`, `payments`, `lifecycle`. |
| `src/app/api/payroll-runs/route.ts` | `POST` — start a run. |
| `src/app/api/payroll-runs/[id]/route.ts` | `GET` — full run state including live stage from Temporal query. |
| `src/app/api/payroll-runs/[id]/approve/route.ts` | `POST` — deliver approval decision (DB-first, then signal). |
| `src/app/api/payroll-runs/[id]/exceptions/[exId]/resolve/route.ts` | `POST` — typed exception resolution. Action must match exception kind. |
| `src/app/api/payroll-runs/[id]/employees/route.ts` | `GET` — per-employee status grid. |
| `src/inngest/functions.ts` | Daily scheduler + manual-trigger event handler. |

---

## Design choices worth flagging

### 1. Per-employee child workflows, not `Promise.all` inside the parent

The naive approach to "pay 28 people" is one workflow with a Promise.all over the activities. The right approach is one child workflow per employee. Three reasons:

- **Failure isolation.** A bank rejection on Sofia's IBAN doesn't propagate. The child workflow ends in `FAILED`, the parent reads it from `Promise.allSettled` and keeps going.
- **Per-employee Temporal history.** When AP asks "what happened to Marcus's payment?", they get a clean 8-event history scoped to him, not a filtered slice of a 1000-event parent history.
- **Different retry shapes per rail.** SEPA Faster and SWIFT have very different reasonable retry windows. Child workflows are the natural seam to differentiate.

### 2. Exceptions are first-class, not thrown

Every anticipated failure (missing IBAN, low treasury, approver OOO, bank rejection) is a typed `Exception` row with a Zod-validated payload. The workflow doesn't `try/catch` these — it routes them. The `/resolve` endpoint enforces that the resolution action matches the exception type (you can't "AUTO" resolve a missing IBAN). Activity-level throws are reserved for *unanticipated* failures and propagate through Temporal's retry policy.

### 3. Delegate chains, not "alert the human"

`src/lib/delegate-chain.ts` encodes who-can-approve-when as a policy:

```ts
CFO: [CFO, HEAD_OF_FINANCE, CEO]
```

When the CFO is OOO, the system walks the chain at request-time and routes to the Head of Finance with a tighter (2h vs 4h) SLA. The Approval row stores BOTH `requestedRole` and `resolvedApprover`, so the audit log captures that the chain policy authorised the delegate — not that the system improvised.

### 4. Idempotency keys are deterministic, not generated

`paymentIdempotencyKey({ runId, employeeRef, currency, netAmount })` returns the same key every time. Same payment retry from Temporal → same key → bank-side dedup catches the duplicate. A salary correction (different amount) gets a different key, which forces it to be a separate payment, not a silent overwrite. Money in minor units in the canonical string so floating-point doesn't bite us.

### 5. Treasury check before EXECUTE, not after the first NSF

Most payroll bugs come from kicking off payments and discovering halfway through that funding is short. The FUND stage explicitly verifies `available >= required` and triggers a typed `INSUFFICIENT_TREASURY` exception with `suggestedSource: MMF_SWEEP` if not. The `/resolve` endpoint runs the sweep, signals the workflow, and the workflow retries `fundRun()` (which is idempotent on the activity side). EXECUTE never starts on an underfunded account.

### 6. `awaitSettlement` uses Temporal heartbeats

SEPA Faster Payments can take up to 2 hours to settle. Polling activities use `heartbeat()` so Temporal knows we're alive without holding a thread, and respect `cancellationSignal.aborted` so a cancel signal cleanly aborts polling.

---

## Quickstart

```bash
npm install

# Infra (separate terminals)
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
temporal server start-dev
npx inngest-cli@latest dev

# Configure
cp .env.example .env.local

# DB
npm run db:migrate
npm run db:seed

# Runtime (separate terminals)
npm run worker
npm run dev
```

Exercise the API:

```bash
# Start a payroll run
curl -X POST http://localhost:3000/api/payroll-runs \
  -H "content-type: application/json" \
  -d '{
    "periodStart":"2026-05-01",
    "periodEnd":  "2026-05-31",
    "payDate":    "2026-05-28",
    "currency":   "GBP",
    "triggeredBy":"u_demo"
  }'
# → { "runId":"cmxxx...", "status":"RUNNING" }

# Watch the run's state — stage, counts, pending exceptions
curl http://localhost:3000/api/payroll-runs/cmxxx.../

# When it hits APPROVAL (or exception)
curl -X POST http://localhost:3000/api/payroll-runs/cmxxx.../approve \
  -H "content-type: application/json" \
  -d '{"decision":"APPROVED","approverId":"u_cfo"}'

# When an exception fires (e.g. low treasury)
curl -X POST 'http://localhost:3000/api/payroll-runs/cmxxx.../exceptions/cmyyy.../resolve' \
  -H "content-type: application/json" \
  -d '{"action":"AUTO","resolvedBy":"u_admin"}'

# Per-employee status grid
curl 'http://localhost:3000/api/payroll-runs/cmxxx.../employees?status=SETTLED'
```

---



---

Built by Sameer M · 2026 · 
