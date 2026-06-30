import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GraphqlSecurityConfig {
  constructor(private readonly config: ConfigService) {}

  get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  get introspection(): boolean {
    return this.config.get<boolean>('GRAPHQL_INTROSPECTION') ?? !this.isProduction;
  }

  get graphiql(): boolean {
    return this.config.get<boolean>('GRAPHQL_GRAPHIQL') ?? !this.isProduction;
  }

  get maxDepth(): number {
    return this.config.getOrThrow<number>('GRAPHQL_MAX_DEPTH');
  }

  get maxComplexity(): number {
    return this.config.getOrThrow<number>('GRAPHQL_MAX_COMPLEXITY');
  }

  get defaultFieldCost(): number {
    return this.config.getOrThrow<number>('GRAPHQL_DEFAULT_FIELD_COST');
  }

  get maxQueryNodes(): number {
    return this.config.getOrThrow<number>('GRAPHQL_MAX_QUERY_NODES');
  }

  get rateLimitWindowSeconds(): number {
    return this.config.getOrThrow<number>('GRAPHQL_RATE_LIMIT_WINDOW_SECONDS');
  }

  get rateLimitMaxCost(): number {
    return this.config.getOrThrow<number>('GRAPHQL_RATE_LIMIT_MAX_COST');
  }

  get rateLimitFailClosed(): boolean {
    return this.config.getOrThrow<boolean>('GRAPHQL_RATE_LIMIT_FAIL_CLOSED');
  }

  get cacheTtlSeconds(): number {
    return this.config.getOrThrow<number>('GRAPHQL_CACHE_TTL_SECONDS');
  }

  get trustedDocumentsEnabled(): boolean {
    return this.config.getOrThrow<boolean>('GRAPHQL_TRUSTED_DOCUMENTS_ENABLED');
  }

  get trustedDocumentHashes(): Set<string> {
    const hashes = this.config.getOrThrow<string>('GRAPHQL_TRUSTED_DOCUMENT_HASHES');

    return new Set(
      hashes
        .split(',')
        .map((hash) => hash.trim().toLowerCase())
        .filter(Boolean)
    );
  }
}
