import { Client, Connection } from '@temporalio/client';

let cached: Client | undefined;
let inflight: Promise<Client> | undefined;

export async function getTemporalClient(): Promise<Client> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    });
    const client = new Client({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    });
    cached = client;
    return client;
  })();

  return inflight;
}

export const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'payrollpilot';
