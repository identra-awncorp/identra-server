import { Module } from '@nestjs/common';

import { DemoPortalModule } from '../demo-portal/demo-portal.controller';
import { IssuerProtocolController, PortalOffersController } from './issuer.controllers';
import { issuerProviders, ISSUERS } from './issuers';
import { TRUST_LIST_MONITOR, trustListProviders } from './trust-list';
import { STATUS_CHANGE_HOOKS, VcCredentialsService } from './vc-credentials.service';
import { CredentialStatusController, IssuerAdminGuard, StatusListController, TrustListController } from './vc.controllers';
import { CLOCK, PKI, STATUS_CHECKER, STATUS_LIST_SERVICE, TRUST_LIST_SERVICE, TRUST_REGISTRY, vcProviders } from './vc.providers';
import { Oid4vpController, VerificationSessionsController } from './verification.controllers';
import { VERIFIER_CLOCK, VERIFIER_MONITOR, verifierProviders, VERIFIERS } from './verifiers';

/**
 * Credential features (docs/vc-api.md §3–§6). Loaded only when IDENTRA_KEYS_DIR is set
 * (AppModule), so auth-only deployments and tests run without keys.
 */
@Module({
  imports: [DemoPortalModule],
  controllers: [
    TrustListController,
    StatusListController,
    CredentialStatusController,
    IssuerProtocolController,
    PortalOffersController,
    VerificationSessionsController,
    Oid4vpController
  ],
  providers: [
    ...vcProviders,
    ...trustListProviders,
    ...issuerProviders,
    ...verifierProviders,
    { provide: VERIFIER_CLOCK, useExisting: CLOCK },
    // Test seam only (delays inside a status change); nothing in production.
    { provide: STATUS_CHANGE_HOOKS, useValue: {} },
    VcCredentialsService,
    IssuerAdminGuard
  ],
  exports: [
    PKI,
    TRUST_LIST_SERVICE,
    TRUST_LIST_MONITOR,
    STATUS_LIST_SERVICE,
    TRUST_REGISTRY,
    STATUS_CHECKER,
    ISSUERS,
    VERIFIERS,
    VERIFIER_MONITOR,
    VcCredentialsService
  ]
})
export class VcModule {}
