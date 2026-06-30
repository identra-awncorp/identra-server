import { Field, GraphQLISODateTime, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('Issuer')
export class GqlIssuer {
  @Field(() => String)
  id: string;

  @Field(() => String)
  did: string;

  @Field(() => String)
  name: string;

  @Field(() => String)
  type: string;

  @Field(() => String)
  trustLevel: string;
}

@ObjectType('CredentialAttribute')
export class GqlCredentialAttribute {
  @Field(() => String)
  id: string;

  @Field(() => String)
  label: string;

  @Field(() => String, { nullable: true })
  value: string | null;

  @Field(() => Boolean)
  sensitive: boolean;

  credentialHolderId: string;
}

@ObjectType('Credential')
export class GqlCredential {
  @Field(() => String)
  id: string;

  @Field(() => String)
  title: string;

  @Field(() => String)
  type: string;

  @Field(() => String)
  status: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  issuedAt: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  expiresAt: Date | null;

  @Field(() => GqlIssuer, { nullable: true })
  issuer: GqlIssuer | null;

  @Field(() => [GqlCredentialAttribute])
  attributes: GqlCredentialAttribute[];

  issuerId: string | null;

  holderId: string;
}

@ObjectType('Notification')
export class GqlNotification {
  @Field(() => String)
  id: string;

  @Field(() => String)
  title: string;

  @Field(() => String)
  body: string;

  @Field(() => String)
  channel: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  readAt: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;
}

@ObjectType('ActivityLog')
export class GqlActivityLog {
  @Field(() => String)
  id: string;

  @Field(() => String)
  type: string;

  @Field(() => String, { nullable: true })
  status: string | null;

  @Field(() => String)
  title: string;

  @Field(() => String)
  description: string;

  @Field(() => String)
  partner: string;

  @Field(() => Boolean)
  unread: boolean;

  @Field(() => Boolean)
  isDemo: boolean;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  expiresAt: Date | null;
}

@ObjectType('MiniApp')
export class GqlMiniApp {
  @Field(() => String)
  id: string;

  @Field(() => String)
  slug: string;

  @Field(() => String)
  name: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field(() => [String])
  scopes: string[];

  @Field(() => String, { nullable: true })
  launchUrl: string | null;
}

@ObjectType('FeedPost')
export class GqlFeedPost {
  @Field(() => String)
  id: string;

  @Field(() => String)
  authorName: string;

  @Field(() => String, { nullable: true })
  handle: string | null;

  @Field(() => String)
  text: string;

  @Field(() => String)
  kind: string;

  @Field(() => GraphQLISODateTime)
  publishedAt: Date;
}

@ObjectType('DemoScenario')
export class GqlDemoScenario {
  @Field(() => String)
  id: string;

  @Field(() => String)
  slug: string;

  @Field(() => String)
  title: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field(() => String)
  status: string;
}

@ObjectType('User')
export class GqlUser {
  @Field(() => String)
  id: string;

  @Field(() => String, { nullable: true })
  did: string | null;

  @Field(() => String)
  fullName: string;

  @Field(() => String, { nullable: true })
  dob: string | null;

  @Field(() => String, { nullable: true })
  studentId: string | null;

  @Field(() => String, { nullable: true })
  nationalId: string | null;

  @Field(() => String, { nullable: true })
  email: string | null;

  @Field(() => String, { nullable: true })
  phone: string | null;

  @Field(() => String, { nullable: true })
  address: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;

  @Field(() => [GqlCredential])
  credentials: GqlCredential[];

  @Field(() => [GqlNotification])
  notifications: GqlNotification[];

  @Field(() => [GqlActivityLog])
  activity: GqlActivityLog[];

  @Field(() => [GqlMiniApp])
  miniApps: GqlMiniApp[];
}

@ObjectType('GraphqlRateLimit')
export class GqlRateLimit {
  @Field(() => Int)
  limit: number;

  @Field(() => Int)
  remaining: number;

  @Field(() => Int)
  used: number;

  @Field(() => GraphQLISODateTime)
  resetAt: Date;
}

@ObjectType('GraphqlMeta')
export class GqlMeta {
  @Field(() => Int, { nullable: true })
  requestCost: number | null;

  @Field(() => GqlRateLimit, { nullable: true })
  rateLimit: GqlRateLimit | null;
}
