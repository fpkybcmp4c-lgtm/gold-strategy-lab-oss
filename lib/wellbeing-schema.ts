import { z } from 'zod';

const rating = z.number().int().min(0).max(10).nullable().optional();
export const wellbeingSchema = z.object({
  stress: rating,
  worry: rating,
  energy: rating,
  sleepHours: z.number().finite().min(0).max(24).nullable().optional(),
  exercised: z.boolean().nullable().optional(),
  trigger: z.string().max(5000).optional(),
  recoveryUrgency: z.boolean().nullable().optional(),
  impulsiveReversal: z.boolean().nullable().optional(),
  // Optional context for existing violations, never an additional violation count.
  violationContexts: z.array(z.object({
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
    fatigued: z.boolean().nullable(),
  })).max(100).optional(),
});
export type Wellbeing = z.infer<typeof wellbeingSchema>;
