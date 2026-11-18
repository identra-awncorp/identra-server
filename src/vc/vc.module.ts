import { Module } from '@nestjs/common';

import { DemoPortalModule } from '../demo-portal/demo-portal.controller';
import { VcCredentialsService } from './vc-credentials.service';
import { CredentialStatusController, IssuerAdminGuard, StatusListController, TrustListController } from './vc.controllers';
import { STATUS_CHECKER, STATUS_LIST_SERVICE, TRUST_LIST_SERVICE, TRUST_REGISTRY, vcProviders, PKI } from './vc.providers';

/**
 * Credential features (docs/vc-api.md §3; issuance and verification come next). Loaded only when
 * IDENTRA_KEYS_DIR is set (AppModule), so auth-only deployments and tests run without keys.
 */
@Module({
  imports: [DemoPortalModule],
  controllers: [TrustListController, StatusListController, CredentialStatusController],
  providers: [...vcProviders, VcCredentialsService, IssuerAdminGuard],
  exports: [PKI, TRUST_LIST_SERVICE, STATUS_LIST_SERVICE, TRUST_REGISTRY, STATUS_CHECKER, VcCredentialsService]
})
export class VcModule {}
