import { z } from 'zod';

export const DemoScenarioSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(['draft', 'active', 'archived']),
  payload: z.record(z.unknown())
});

export type DemoScenarioContract = z.infer<typeof DemoScenarioSchema>;
