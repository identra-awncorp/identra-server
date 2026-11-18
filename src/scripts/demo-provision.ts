// npm run demo:provision — creates or updates the school portal's sample accounts
// (docs/vc-api.md §5). Idempotent and safe on production: it only upserts the rows of
// DemoPortalAccount listed in DEMO_ACCOUNTS and touches no other table. The password comes
// from DEMO_PORTAL_PASSWORD (the public demo uses the one printed on the portal's sign-in page).
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

import { DEMO_ACCOUNTS, DEMO_ISSUER, PORTAL_PASSWORD_HASH } from '../demo-portal/demo-accounts';

async function main(): Promise<void> {
  const password = process.env.DEMO_PORTAL_PASSWORD;

  if (!password || password.length < 8) {
    console.error('demo:provision refuses to run: set DEMO_PORTAL_PASSWORD (at least 8 characters).');
    process.exitCode = 1;

    return;
  }

  const prisma = new PrismaClient();

  try {
    for (const account of DEMO_ACCOUNTS) {
      const passwordHash = await argon2.hash(password, PORTAL_PASSWORD_HASH);
      const data = { passwordHash, role: account.role, issuerName: DEMO_ISSUER, profile: { ...account.profile } };

      await prisma.demoPortalAccount.upsert({
        where: { username: account.username },
        create: { username: account.username, ...data },
        update: data
      });
      console.log(`demo:provision: ${account.username} (${account.role})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`demo:provision failed: ${error instanceof Error ? error.name : 'error'}`);
  process.exitCode = 1;
});
