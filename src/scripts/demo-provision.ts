// npm run demo:provision — creates or updates the school portal's sample accounts
// (docs/vc-api.md §5). Idempotent and safe on production: it only upserts the rows of
// DemoPortalAccount listed in DEMO_ACCOUNTS and touches no other table. With DPKI configured
// (CERTNET_GATEWAY_URL and CERTNET_NETWORK) also the same people under `cn-` names for the DID
// issuer truong-mau-certnet, with that school's own registrar unit and diploma series. Two passwords:
// DEMO_PORTAL_PASSWORD for the students (public: the portal's sign-in page prints it) and
// DEMO_PORTAL_REGISTRAR_PASSWORD for the registrar (private: it can revoke every diploma; at least
// 20 characters, its account name is public).
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

import { certnetConfig } from '../config/env.validation';
import { DEMO_ACCOUNTS, DEMO_DID_ACCOUNTS, DEMO_DID_ISSUER, DEMO_ISSUER, DID_ACCOUNT_PREFIX, PORTAL_PASSWORD_HASH } from '../demo-portal/demo-accounts';

function refusal(student: string | undefined, registrar: string | undefined): string | null {
  if (!student || student.length < 8) return 'set DEMO_PORTAL_PASSWORD (the public student password, at least 8 characters)';
  if (!registrar || registrar.length < 20) {
    return 'set DEMO_PORTAL_REGISTRAR_PASSWORD (the private registrar password, at least 20 characters, e.g. `openssl rand -base64 24`)';
  }
  if (registrar === student) return 'DEMO_PORTAL_REGISTRAR_PASSWORD must differ from the public DEMO_PORTAL_PASSWORD';

  return null;
}

async function main(): Promise<void> {
  const passwords = { student: process.env.DEMO_PORTAL_PASSWORD, registrar: process.env.DEMO_PORTAL_REGISTRAR_PASSWORD };
  const refused = refusal(passwords.student, passwords.registrar);

  if (refused) {
    console.error(`demo:provision refuses to run: ${refused}.`);
    process.exitCode = 1;

    return;
  }

  let dpki: boolean;

  try {
    dpki = certnetConfig(process.env) !== null;
  } catch (error) {
    // The message names the variable, never its value.
    console.error(`demo:provision refuses to run: ${(error as Error).message}.`);
    process.exitCode = 1;

    return;
  }

  const portals = [
    { issuerName: DEMO_ISSUER, prefix: '', accounts: DEMO_ACCOUNTS },
    ...(dpki ? [{ issuerName: DEMO_DID_ISSUER, prefix: DID_ACCOUNT_PREFIX, accounts: DEMO_DID_ACCOUNTS }] : [])
  ];
  const prisma = new PrismaClient();

  try {
    for (const { issuerName, prefix, accounts } of portals) {
      for (const account of accounts) {
        const username = `${prefix}${account.username}`;
        const passwordHash = await argon2.hash(passwords[account.role]!, PORTAL_PASSWORD_HASH);
        const data = { passwordHash, role: account.role, issuerName, profile: { ...account.profile } };

        await prisma.demoPortalAccount.upsert({ where: { username }, create: { username, ...data }, update: data });
        console.log(`demo:provision: ${username} (${account.role})`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`demo:provision failed: ${error instanceof Error ? error.name : 'error'}`);
  process.exitCode = 1;
});
