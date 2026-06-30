import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Args, Context, Extensions, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ComplexityEstimatorArgs } from 'graphql-query-complexity';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { GraphqlCacheService } from '../graphql-cache.service';
import { GraphqlContext } from '../graphql.context';
import {
  mapActivityLog,
  mapCredential,
  mapDemoScenario,
  mapFeedPost,
  mapMiniApp,
  mapNotification,
  mapUser
} from '../graphql.mappers';
import { GraphqlPolicyService } from '../graphql-policy.service';
import {
  GqlActivityLog,
  GqlCredential,
  GqlDemoScenario,
  GqlFeedPost,
  GqlMeta,
  GqlMiniApp,
  GqlNotification,
  GqlUser
} from '../models/graphql.models';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

@Resolver()
export class ViewerResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: GraphqlCacheService,
    private readonly policy: GraphqlPolicyService
  ) {}

  @Query(() => GqlUser, { nullable: true })
  @Extensions({ complexity: 5 })
  async viewer(@Context() context: GraphqlContext): Promise<GqlUser | null> {
    const user = context.identity.userId
      ? await this.prisma.user.findUnique({ where: { id: context.identity.userId } })
      : await this.prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });

    return user ? mapUser(user) : null;
  }

  @Query(() => GqlCredential, { nullable: true })
  @Extensions({ complexity: 10 })
  async credential(
    @Args('id', { type: () => String }) id: string,
    @Context() context: GraphqlContext
  ): Promise<GqlCredential | null> {
    const credential = await this.prisma.credential.findUnique({ where: { id } });

    if (!credential) {
      return null;
    }

    if (!this.policy.canReadCredential(context.identity, credential.holderId)) {
      throw new ForbiddenException('You are not allowed to read this credential.');
    }

    return mapCredential(credential);
  }

  @Query(() => [GqlMiniApp])
  @Extensions({ complexity: listComplexity })
  async miniApps(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: DEFAULT_PAGE_SIZE })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number
  ): Promise<GqlMiniApp[]> {
    const page = normalizePage(limit, offset);
    const miniApps = await this.cache.getOrSet(`mini-apps:${page.limit}:${page.offset}`, () =>
      this.prisma.miniApp.findMany({
        where: { isEnabled: true },
        orderBy: { createdAt: 'asc' },
        take: page.limit,
        skip: page.offset
      })
    );

    return miniApps.map(mapMiniApp);
  }

  @Query(() => [GqlDemoScenario])
  @Extensions({ complexity: listComplexity })
  async demoScenarios(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: DEFAULT_PAGE_SIZE })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number
  ): Promise<GqlDemoScenario[]> {
    const page = normalizePage(limit, offset);
    const scenarios = await this.cache.getOrSet(
      `demo-scenarios:${page.limit}:${page.offset}`,
      () =>
        this.prisma.demoScenario.findMany({
          orderBy: { createdAt: 'asc' },
          take: page.limit,
          skip: page.offset
        })
    );

    return scenarios.map(mapDemoScenario);
  }

  @Query(() => GqlMeta)
  @Extensions({ complexity: 1 })
  graphqlMeta(@Context() context: GraphqlContext): GqlMeta {
    return {
      requestCost: context.requestCost ?? null,
      rateLimit: context.rateLimit ?? null
    };
  }
}

@Resolver(() => GqlUser)
export class UserFieldResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: GraphqlCacheService,
    private readonly policy: GraphqlPolicyService
  ) {}

  @ResolveField(() => String, { nullable: true })
  dob(@Parent() user: GqlUser, @Context() context: GraphqlContext): string | null {
    return this.policy.canReadPrivateUserField(context.identity, user.id) ? user.dob : null;
  }

  @ResolveField(() => String, { nullable: true })
  studentId(@Parent() user: GqlUser, @Context() context: GraphqlContext): string | null {
    return this.policy.canReadSensitiveIdentityField(context.identity, user.id)
      ? user.studentId
      : null;
  }

  @ResolveField(() => String, { nullable: true })
  nationalId(@Parent() user: GqlUser, @Context() context: GraphqlContext): string | null {
    return this.policy.canReadSensitiveIdentityField(context.identity, user.id)
      ? user.nationalId
      : null;
  }

  @ResolveField(() => String, { nullable: true })
  email(@Parent() user: GqlUser, @Context() context: GraphqlContext): string | null {
    return this.policy.canReadPrivateUserField(context.identity, user.id) ? user.email : null;
  }

  @ResolveField(() => String, { nullable: true })
  phone(@Parent() user: GqlUser, @Context() context: GraphqlContext): string | null {
    return this.policy.canReadPrivateUserField(context.identity, user.id) ? user.phone : null;
  }

  @ResolveField(() => String, { nullable: true })
  address(@Parent() user: GqlUser, @Context() context: GraphqlContext): string | null {
    return this.policy.canReadPrivateUserField(context.identity, user.id) ? user.address : null;
  }

  @ResolveField(() => [GqlCredential])
  @Extensions({ complexity: listComplexity })
  async credentials(
    @Parent() user: GqlUser,
    @Context() context: GraphqlContext,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: DEFAULT_PAGE_SIZE })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number
  ): Promise<GqlCredential[]> {
    if (!this.policy.canReadCredential(context.identity, user.id)) {
      return [];
    }

    const page = normalizePage(limit, offset);
    const credentials = await this.prisma.credential.findMany({
      where: { holderId: user.id },
      orderBy: { createdAt: 'desc' },
      take: page.limit,
      skip: page.offset
    });

    return credentials.map(mapCredential);
  }

  @ResolveField(() => [GqlNotification])
  @Extensions({ complexity: listComplexity })
  async notifications(
    @Parent() user: GqlUser,
    @Context() context: GraphqlContext,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: DEFAULT_PAGE_SIZE })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number
  ): Promise<GqlNotification[]> {
    if (!this.policy.canReadUser(context.identity, user.id)) {
      return [];
    }

    const page = normalizePage(limit, offset);
    const notifications = await this.prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: page.limit,
      skip: page.offset
    });

    return notifications.map(mapNotification);
  }

  @ResolveField(() => [GqlActivityLog])
  @Extensions({ complexity: listComplexity })
  async activity(
    @Parent() user: GqlUser,
    @Context() context: GraphqlContext,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: DEFAULT_PAGE_SIZE })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number
  ): Promise<GqlActivityLog[]> {
    if (!this.policy.canReadUser(context.identity, user.id)) {
      return [];
    }

    const page = normalizePage(limit, offset);
    const logs = await this.prisma.activityLog.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: page.limit,
      skip: page.offset
    });

    return logs.map(mapActivityLog);
  }

  @ResolveField(() => [GqlMiniApp])
  @Extensions({ complexity: listComplexity })
  async miniApps(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: DEFAULT_PAGE_SIZE })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number
  ): Promise<GqlMiniApp[]> {
    const page = normalizePage(limit, offset);
    const miniApps = await this.cache.getOrSet(`viewer-mini-apps:${page.limit}:${page.offset}`, () =>
      this.prisma.miniApp.findMany({
        where: { isEnabled: true },
        orderBy: { createdAt: 'asc' },
        take: page.limit,
        skip: page.offset
      })
    );

    return miniApps.map(mapMiniApp);
  }

  @ResolveField(() => [GqlFeedPost])
  @Extensions({ complexity: listComplexity })
  async feed(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: DEFAULT_PAGE_SIZE })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number
  ): Promise<GqlFeedPost[]> {
    const page = normalizePage(limit, offset);
    const posts = await this.prisma.feedPost.findMany({
      orderBy: { publishedAt: 'desc' },
      take: page.limit,
      skip: page.offset
    });

    return posts.map(mapFeedPost);
  }
}

function normalizePage(limit: number, offset: number): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(limit, 1), MAX_PAGE_SIZE),
    offset: Math.max(offset, 0)
  };
}

function listComplexity(args: ComplexityEstimatorArgs): number {
  const limit = typeof args.args.limit === 'number' ? args.args.limit : DEFAULT_PAGE_SIZE;
  const safeLimit = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);

  return 2 + safeLimit * Math.max(args.childComplexity, 1);
}
