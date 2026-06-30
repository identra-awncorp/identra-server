import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { GraphQLError } from 'graphql';

import { GraphqlSecurityConfig } from './graphql-security.config';

interface TrustedDocumentInput {
  source: string;
  queryHash?: string;
  headerHash?: string | null;
  extensionHash?: string | null;
}

@Injectable()
export class GraphqlTrustedDocumentsService {
  constructor(private readonly securityConfig: GraphqlSecurityConfig) {}

  assertTrusted(input: TrustedDocumentInput): void {
    if (!this.securityConfig.trustedDocumentsEnabled) {
      return;
    }

    const actualHash = normalizeHash(input.queryHash ?? sha256(input.source));
    const declaredHash = normalizeHash(input.headerHash ?? input.extensionHash ?? actualHash);
    const trustedHashes = this.securityConfig.trustedDocumentHashes;

    if (declaredHash !== actualHash) {
      throw new GraphQLError('GraphQL document hash does not match the query body.', {
        extensions: {
          code: 'UNTRUSTED_GRAPHQL_DOCUMENT'
        }
      });
    }

    if (!trustedHashes.has(actualHash)) {
      throw new GraphQLError('GraphQL document is not in the trusted document allowlist.', {
        extensions: {
          code: 'UNTRUSTED_GRAPHQL_DOCUMENT',
          hash: actualHash
        }
      });
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeHash(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}
