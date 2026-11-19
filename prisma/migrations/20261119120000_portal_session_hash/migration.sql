-- School portal: the portal session that created an offer lists and may revoke the credential
-- issued from it (docs/vc-api.md §5). Additive and nullable: older images keep working.
ALTER TABLE "VcIssuedCredential" ADD COLUMN "portalSessionHash" TEXT;

CREATE INDEX "VcIssuedCredential_portalSessionHash_idx" ON "VcIssuedCredential"("portalSessionHash");
