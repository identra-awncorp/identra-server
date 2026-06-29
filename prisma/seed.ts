import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'demo@identra.local' },
    update: {},
    create: {
      did: 'did:identra:demo-holder-001',
      fullName: 'Nguyen Van An',
      dob: '2002-10-15',
      studentId: '20021345',
      school: 'University of Technology',
      nationalId: '001202003847',
      email: 'demo@identra.local',
      phone: '0382948210',
      address: 'Cau Giay, Hanoi',
      settings: {
        language: 'vi',
        theme: 'system',
        notificationsEnabled: true,
        hideSensitiveData: true
      }
    }
  });

  const issuer = await prisma.issuer.upsert({
    where: { did: 'did:identra:uet-academic' },
    update: {},
    create: {
      did: 'did:identra:uet-academic',
      name: 'University of Technology',
      type: 'education',
      trustLevel: 'verified-demo',
      metadata: {
        country: 'VN',
        website: 'https://identra.local/issuers/uet-academic'
      }
    }
  });

  await prisma.credential.upsert({
    where: { id: 'cred-degree-demo' },
    update: {},
    create: {
      id: 'cred-degree-demo',
      holderId: user.id,
      issuerId: issuer.id,
      type: 'academic_degree',
      title: 'Digital Degree',
      status: 'VERIFIED',
      issuedAt: new Date('2024-06-20T03:30:00.000Z'),
      claims: {
        fullName: 'Nguyen Van An',
        degreeStatus: 'graduated',
        major: 'Software Engineering',
        gpa: '3.85 / 4.0'
      },
      proof: {
        type: 'Ed25519Signature2020',
        signature: 'ed25519:demo-signature'
      },
      isDemo: true,
      attributes: {
        create: [
          { label: 'Full name', value: 'Nguyen Van An' },
          { label: 'Degree status', value: 'Graduated' },
          { label: 'Major', value: 'Software Engineering' },
          { label: 'GPA', value: '3.85 / 4.0', isSensitive: true }
        ]
      }
    }
  });

  await prisma.activityLog.upsert({
    where: { id: 'activity-degree-issued-demo' },
    update: {},
    create: {
      id: 'activity-degree-issued-demo',
      userId: user.id,
      type: 'VERIFY',
      status: 'SUCCESS',
      title: 'Digital Degree',
      description: 'Credential verified successfully',
      partner: 'University of Technology',
      unread: true,
      isDemo: true
    }
  });

  await prisma.demoScenario.upsert({
    where: { slug: 'issuer-wallet-verifier' },
    update: {},
    create: {
      slug: 'issuer-wallet-verifier',
      title: 'Issuer to wallet to verifier',
      description: 'Baseline demo flow for website and mobile app.',
      status: 'ACTIVE',
      payload: {
        steps: [
          'issuer_issues_credential',
          'wallet_receives_credential',
          'holder_approves_selective_disclosure',
          'verifier_checks_proof'
        ]
      }
    }
  });

  await prisma.miniApp.upsert({
    where: { slug: 'idpay' },
    update: {},
    create: {
      slug: 'idpay',
      name: 'IDPay',
      description: 'Demo payment mini-app connected to identity verification.',
      scopes: ['identity:read', 'payment:create'],
      metadata: {
        demo: true
      }
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
