// npm run demo:provision — creates or updates the school portal's sample accounts
// (docs/vc-api.md §5). Idempotent and safe on production: it only upserts the rows of
// DemoPortalAccount listed in DEMO_ACCOUNTS and touches no other table. With DPKI configured
// (CERTNET_GATEWAY_URL and CERTNET_NETWORK) also the `cn-` accounts of the DID issuer
// truong-mau-certnet (DEMO_DID_ACCOUNTS: its own people, registrar unit and diploma series).
// Passwords: DEMO_PORTAL_PASSWORD for the students of both schools (public: the portal's sign-in
// page prints it); DEMO_PORTAL_REGISTRAR_PASSWORD for the registrar (private: it can revoke every
// diploma; at least 20 characters, its account name is public); with DPKI configured also
// DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET for the second school's registrar, the same rule and
// different from the first: wrong passwords are counted per account, so one shared secret would
// give twice the guesses and open both schools.
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

import { certnetConfig } from '../config/env.validation';
import { DEMO_ACCOUNTS, DEMO_DID_ACCOUNTS, DEMO_DID_ISSUER, DEMO_ISSUER, DID_ACCOUNT_PREFIX, PORTAL_PASSWORD_HASH } from '../demo-portal/demo-accounts';

type Passwords = { student?: string; registrar?: string };

function registrarRefusal(name: string, registrar: string | undefined, student: string): string | null {
  if (!registrar || registrar.length < 20) {
    return `set ${name} (the private registrar password, at least 20 characters, e.g. \`openssl rand -base64 24\`)`;
  }
  if (registrar === student) return `${name} must differ from the public DEMO_PORTAL_PASSWORD`;

  return null;
}

function refusal(first: Passwords, certnet: Passwords | null): string | null {
  const student = first.student;

  if (!student || student.length < 8) return 'set DEMO_PORTAL_PASSWORD (the public student password, at least 8 characters)';

  const refused = registrarRefusal('DEMO_PORTAL_REGISTRAR_PASSWORD', first.registrar, student);

  if (refused || !certnet) return refused;
  if (certnet.registrar === first.registrar) return 'DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET must differ from DEMO_PORTAL_REGISTRAR_PASSWORD';

  return registrarRefusal('DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET', certnet.registrar, student);
}

async function main(): Promise<void> {
  let dpki: boolean;

  try {
    dpki = certnetConfig(process.env) !== null;
  } catch (error) {
    // The message names the variable, never its value.
    console.error(`demo:provision refuses to run: ${(error as Error).message}.`);
    process.exitCode = 1;

    return;
  }

  const student = process.env.DEMO_PORTAL_PASSWORD;
  const first: Passwords = { student, registrar: process.env.DEMO_PORTAL_REGISTRAR_PASSWORD };
  const certnet: Passwords | null = dpki ? { student, registrar: process.env.DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET } : null;
  const refused = refusal(first, certnet);

  if (refused) {
    console.error(`demo:provision refuses to run: ${refused}.`);
    process.exitCode = 1;

    return;
  }

  const portals = [
    { issuerName: DEMO_ISSUER, prefix: '', accounts: DEMO_ACCOUNTS, passwords: first },
    ...(certnet ? [{ issuerName: DEMO_DID_ISSUER, prefix: DID_ACCOUNT_PREFIX, accounts: DEMO_DID_ACCOUNTS, passwords: certnet }] : [])
  ];
  const prisma = new PrismaClient();

  try {
    for (const { issuerName, prefix, accounts, passwords } of portals) {
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
