import { Injectable } from '@nestjs/common';
import {
  ApolloServerPlugin,
  GraphQLRequestContextDidResolveOperation,
  GraphQLRequestContextDidResolveSource,
  GraphQLRequestContextWillSendResponse
} from '@apollo/server';
import {
  fieldExtensionsEstimator,
  getComplexity,
  simpleEstimator
} from 'graphql-query-complexity';
import { GraphQLError } from 'graphql';

import { GraphqlContext } from './graphql.context';
import { GraphqlCostRateLimiterService } from './graphql-cost-rate-limiter.service';
import { GraphqlSecurityConfig } from './graphql-security.config';
import { GraphqlTrustedDocumentsService } from './graphql-trusted-documents.service';

@Injectable()
export class GraphqlSecurityPlugin implements ApolloServerPlugin<GraphqlContext> {
  constructor(
    private readonly securityConfig: GraphqlSecurityConfig,
    private readonly rateLimiter: GraphqlCostRateLimiterService,
    private readonly trustedDocuments: GraphqlTrustedDocumentsService
  ) {}

  async requestDidStart() {
    return {
      didResolveSource: async (
        requestContext: GraphQLRequestContextDidResolveSource<GraphqlContext>
      ) => {
        this.trustedDocuments.assertTrusted({
          source: requestContext.source,
          queryHash: requestContext.queryHash,
          headerHash: requestContext.request.http?.headers.get('x-graphql-document-sha256'),
          extensionHash: readPersistedQueryHash(requestContext.request.extensions)
        });
      },
      didResolveOperation: async (
        requestContext: GraphQLRequestContextDidResolveOperation<GraphqlContext>
      ) => {
        const complexity = getComplexity({
          schema: requestContext.schema,
          query: requestContext.document,
          variables: requestContext.request.variables,
          operationName: requestContext.operationName ?? undefined,
          maxQueryNodes: this.securityConfig.maxQueryNodes,
          estimators: [
            fieldExtensionsEstimator(),
            simpleEstimator({
              defaultComplexity: this.securityConfig.defaultFieldCost
            })
          ]
        });

        requestContext.contextValue.requestCost = complexity;

        if (complexity > this.securityConfig.maxComplexity) {
          throw new GraphQLError(
            `GraphQL query complexity ${complexity} exceeds max complexity ${this.securityConfig.maxComplexity}.`,
            {
              extensions: {
                code: 'QUERY_COMPLEXITY_LIMIT_EXCEEDED',
                complexity,
                maxComplexity: this.securityConfig.maxComplexity
              }
            }
          );
        }

        requestContext.contextValue.rateLimit = await this.rateLimiter.consume(
          requestContext.contextValue,
          complexity
        );
      },
      willSendResponse: async (
        requestContext: GraphQLRequestContextWillSendResponse<GraphqlContext>
      ) => {
        const { requestCost, rateLimit } = requestContext.contextValue;

        if (requestCost !== undefined) {
          requestContext.response.http.headers.set('x-graphql-cost', String(requestCost));
        }

        if (rateLimit) {
          requestContext.response.http.headers.set('x-graphql-rate-limit', String(rateLimit.limit));
          requestContext.response.http.headers.set(
            'x-graphql-rate-limit-remaining',
            String(rateLimit.remaining)
          );
          requestContext.response.http.headers.set(
            'x-graphql-rate-limit-reset',
            rateLimit.resetAt.toISOString()
          );
        }
      }
    };
  }
}

function readPersistedQueryHash(extensions: Record<string, unknown> | undefined): string | null {
  const persistedQuery = extensions?.persistedQuery;

  if (!persistedQuery || typeof persistedQuery !== 'object') {
    return null;
  }

  const hash = (persistedQuery as { sha256Hash?: unknown }).sha256Hash;

  return typeof hash === 'string' ? hash : null;
}
