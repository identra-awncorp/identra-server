import { HttpException, Module } from '@nestjs/common';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { GraphQLError, GraphQLFormattedError } from 'graphql';

import { AuthModule } from '../modules/auth/auth.module';
import { createDepthLimitRule } from './graphql-depth-limit.rule';
import { GraphqlCacheService } from './graphql-cache.service';
import { GraphqlHttpRequest } from './graphql.context';
import { GraphqlContextFactory } from './graphql-context.factory';
import { GraphqlCostRateLimiterService } from './graphql-cost-rate-limiter.service';
import { GraphqlLoadersService } from './graphql-loaders.service';
import { GraphqlPolicyService } from './graphql-policy.service';
import { GraphqlSecurityConfig } from './graphql-security.config';
import { GraphqlSecurityPlugin } from './graphql-security.plugin';
import { GraphqlTrustedDocumentsService } from './graphql-trusted-documents.service';
import {
  CredentialAttributeFieldResolver,
  CredentialFieldResolver
} from './resolvers/credential.resolver';
import { UserFieldResolver, ViewerResolver } from './resolvers/viewer.resolver';

/**
 * Production only. Errors we raise on purpose (GraphQLError from our plugins, validation and
 * context; HttpException from resolvers) keep their message minus "Did you mean" schema hints.
 * Anything else (Prisma, Redis, bugs) may name hosts, ports or queries and becomes generic.
 */
export function formatProductionError(
  formatted: GraphQLFormattedError,
  error: unknown
): GraphQLFormattedError {
  let original = error;

  while (original instanceof GraphQLError && original.originalError) {
    original = original.originalError;
  }

  if (!(original instanceof GraphQLError || original instanceof HttpException)) {
    return { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } };
  }

  return { ...formatted, message: formatted.message.replace(/\s*Did you mean .*$/s, '') };
}

const graphqlProviders = [
  GraphqlSecurityConfig,
  GraphqlContextFactory,
  GraphqlLoadersService,
  GraphqlPolicyService,
  GraphqlCacheService,
  GraphqlCostRateLimiterService,
  GraphqlTrustedDocumentsService,
  GraphqlSecurityPlugin
];

@Module({
  imports: [AuthModule],
  providers: graphqlProviders,
  exports: graphqlProviders
})
class GraphqlProvidersModule {}

@Module({
  imports: [
    GraphqlProvidersModule,
    NestGraphQLModule.forRootAsync<ApolloDriverConfig>({
      imports: [GraphqlProvidersModule],
      driver: ApolloDriver,
      inject: [GraphqlContextFactory, GraphqlSecurityConfig, GraphqlSecurityPlugin],
      useFactory: (
        contextFactory: GraphqlContextFactory,
        securityConfig: GraphqlSecurityConfig,
        securityPlugin: GraphqlSecurityPlugin
      ) => ({
        autoSchemaFile: true,
        sortSchema: true,
        path: '/graphql',
        useGlobalPrefix: false,
        context: ({ req }: { req?: GraphqlHttpRequest }) => contextFactory.create(req),
        introspection: securityConfig.introspection,
        graphiql: securityConfig.graphiql,
        debug: !securityConfig.isProduction,
        formatError: securityConfig.isProduction ? formatProductionError : undefined,
        persistedQueries: false,
        validationRules: [createDepthLimitRule(securityConfig.maxDepth)],
        plugins: [securityPlugin],
        fieldResolverEnhancers: ['guards', 'interceptors', 'filters']
      })
    })
  ],
  providers: [
    ViewerResolver,
    UserFieldResolver,
    CredentialFieldResolver,
    CredentialAttributeFieldResolver
  ]
})
export class IdentraGraphqlModule {}
