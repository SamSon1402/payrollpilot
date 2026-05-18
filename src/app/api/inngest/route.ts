import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { scheduler, manualTrigger } from '@/inngest/functions';

export const runtime = 'nodejs';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [scheduler, manualTrigger],
});
