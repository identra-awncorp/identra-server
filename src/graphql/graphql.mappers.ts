import {
  ActivityLog,
  ActivityStatus,
  ActivityType,
  Credential,
  CredentialAttribute,
  CredentialStatus,
  DemoScenario,
  DemoScenarioStatus,
  FeedPost,
  Issuer,
  MiniApp,
  Notification,
  User
} from '@prisma/client';

import {
  GqlActivityLog,
  GqlCredential,
  GqlCredentialAttribute,
  GqlDemoScenario,
  GqlFeedPost,
  GqlIssuer,
  GqlMiniApp,
  GqlNotification,
  GqlUser
} from './models/graphql.models';

const credentialStatusMap: Record<CredentialStatus, string> = {
  VERIFIED: 'verified',
  PENDING: 'pending',
  EXPIRED: 'expired',
  FAILED: 'failed',
  UNAVAILABLE: 'unavailable'
};

const activityTypeMap: Record<ActivityType, string> = {
  VERIFY: 'verify',
  SHARE: 'share',
  ADD: 'add',
  SECURITY: 'security',
  SCAN: 'scan',
  PAYMENT: 'payment',
  CHAT: 'chat'
};

const activityStatusMap: Record<ActivityStatus, string> = {
  SUCCESS: 'success',
  PENDING: 'pending',
  FAILED: 'failed'
};

const demoScenarioStatusMap: Record<DemoScenarioStatus, string> = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  ARCHIVED: 'archived'
};

export function mapUser(user: User): GqlUser {
  return {
    id: user.id,
    did: user.did,
    fullName: user.fullName,
    dob: user.dob,
    studentId: user.studentId,
    nationalId: user.nationalId,
    email: user.email,
    phone: user.phone,
    address: user.address,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    credentials: [],
    notifications: [],
    activity: [],
    miniApps: []
  };
}

export function mapCredential(credential: Credential): GqlCredential {
  return {
    id: credential.id,
    title: credential.title,
    type: credential.type,
    status: credentialStatusMap[credential.status],
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt,
    issuer: null,
    attributes: [],
    issuerId: credential.issuerId,
    holderId: credential.holderId
  };
}

export function mapCredentialAttribute(
  attribute: CredentialAttribute,
  credentialHolderId: string
): GqlCredentialAttribute {
  return {
    id: attribute.id,
    label: attribute.label,
    value: attribute.value,
    sensitive: attribute.isSensitive,
    credentialHolderId
  };
}

export function mapIssuer(issuer: Issuer): GqlIssuer {
  return {
    id: issuer.id,
    did: issuer.did,
    name: issuer.name,
    type: issuer.type,
    trustLevel: issuer.trustLevel
  };
}

export function mapNotification(notification: Notification): GqlNotification {
  return {
    id: notification.id,
    title: notification.title,
    body: notification.body,
    channel: notification.channel,
    readAt: notification.readAt,
    createdAt: notification.createdAt
  };
}

export function mapActivityLog(log: ActivityLog): GqlActivityLog {
  return {
    id: log.id,
    type: activityTypeMap[log.type],
    status: log.status ? activityStatusMap[log.status] : null,
    title: log.title,
    description: log.description,
    partner: log.partner,
    unread: log.unread,
    isDemo: log.isDemo,
    createdAt: log.createdAt,
    expiresAt: log.expiresAt
  };
}

export function mapMiniApp(miniApp: MiniApp): GqlMiniApp {
  return {
    id: miniApp.id,
    slug: miniApp.slug,
    name: miniApp.name,
    description: miniApp.description,
    scopes: miniApp.scopes,
    launchUrl: miniApp.launchUrl
  };
}

export function mapFeedPost(post: FeedPost): GqlFeedPost {
  return {
    id: post.id,
    authorName: post.authorName,
    handle: post.handle,
    text: post.text,
    kind: post.kind,
    publishedAt: post.publishedAt
  };
}

export function mapDemoScenario(scenario: DemoScenario): GqlDemoScenario {
  return {
    id: scenario.id,
    slug: scenario.slug,
    title: scenario.title,
    description: scenario.description,
    status: demoScenarioStatusMap[scenario.status]
  };
}
