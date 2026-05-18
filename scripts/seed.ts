import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Just creates the run — the workflow itself does the ingestion.
  // In production this is what the /api/payroll-runs POST handler does;
  // here it's a convenience for local development.
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const payDate     = new Date(now.getFullYear(), now.getMonth(), 28);

  const run = await prisma.payrollRun.create({
    data: {
      periodStart,
      periodEnd,
      payDate,
      currency: 'GBP',
      triggeredBy: 'seed-script',
      status: 'PENDING',
    },
  });
  console.log(`seeded payroll run ${run.id} (period ${periodStart.toISOString().slice(0, 10)} → ${periodEnd.toISOString().slice(0, 10)})`);
  console.log(`\nTo execute it:`);
  console.log(`  curl -X POST http://localhost:3000/api/payroll-runs/${run.id}/execute`);
  console.log(`  # or call POST /api/payroll-runs directly with the body documented in the README`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
