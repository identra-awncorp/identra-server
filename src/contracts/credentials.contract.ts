import { z } from 'zod';

export const CredentialStatusSchema = z.enum([
  'verified',
  'pending',
  'expired',
  'failed',
  'unavailable'
]);

export const CredentialAttributeSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  sensitive: z.boolean().default(false)
});

export const CredentialSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  issuer: z
    .object({
      did: z.string(),
      name: z.string()
    })
    .nullable(),
  status: CredentialStatusSchema,
  issuedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  attributes: z.array(CredentialAttributeSchema)
});

export type CredentialContract = z.infer<typeof CredentialSchema>;
