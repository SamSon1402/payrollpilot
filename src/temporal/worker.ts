import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  // Both parent and child workflows live in the same worker process —
  // they share activity implementations and the dispatching cost
  // between them is local. For very large fleets we'd split per
  // workflow type onto different task queues so payment retries don't
  // starve the parent's coordination work.
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'payrollpilot',
    workflowsPath: require.resolve('./workflows'),
    activities,
    maxConcurrentActivityTaskExecutions: 100,
    maxConcurrentWorkflowTaskExecutions: 50,
  });

  process.on('SIGTERM', () => worker.shutdown());
  process.on('SIGINT',  () => worker.shutdown());

  console.log(`[worker] task_queue=${worker.options.taskQueue} ready`);
  await worker.run();
  console.log('[worker] shutdown complete');
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
