import { Injectable } from '@nestjs/common';

import { GraphqlIdentity } from './graphql.context';

@Injectable()
export class GraphqlPolicyService {
  canReadUser(identity: GraphqlIdentity, ownerId: string): boolean {
    return this.isPrivileged(identity) || identity.userId === ownerId;
  }

  canReadPrivateUserField(identity: GraphqlIdentity, ownerId: string): boolean {
    return (
      this.isPrivileged(identity) ||
      identity.userId === ownerId ||
      identity.scopes.has('identity:read')
    );
  }

  canReadSensitiveIdentityField(identity: GraphqlIdentity, ownerId: string): boolean {
    return (
      this.isPrivileged(identity) ||
      identity.scopes.has('identity:sensitive:read') ||
      (identity.userId === ownerId && identity.highAssurance)
    );
  }

  canReadCredential(identity: GraphqlIdentity, holderId: string): boolean {
    return (
      this.isPrivileged(identity) ||
      identity.userId === holderId ||
      identity.scopes.has('credentials:read')
    );
  }

  canReadSensitiveCredentialField(identity: GraphqlIdentity, holderId: string): boolean {
    return (
      this.isPrivileged(identity) ||
      identity.scopes.has('credentials:sensitive:read') ||
      (identity.userId === holderId && identity.highAssurance)
    );
  }

  private isPrivileged(identity: GraphqlIdentity): boolean {
    return identity.role === 'admin' || identity.role === 'service';
  }
}
