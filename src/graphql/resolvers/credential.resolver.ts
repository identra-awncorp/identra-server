import { Context, Parent, ResolveField, Resolver } from '@nestjs/graphql';

import { GraphqlContext } from '../graphql.context';
import { mapCredentialAttribute, mapIssuer } from '../graphql.mappers';
import { GraphqlPolicyService } from '../graphql-policy.service';
import {
  GqlCredential,
  GqlCredentialAttribute,
  GqlIssuer
} from '../models/graphql.models';

@Resolver(() => GqlCredential)
export class CredentialFieldResolver {
  constructor(private readonly policy: GraphqlPolicyService) {}

  @ResolveField(() => GqlIssuer, { nullable: true })
  async issuer(
    @Parent() credential: GqlCredential,
    @Context() context: GraphqlContext
  ): Promise<GqlIssuer | null> {
    if (!credential.issuerId) {
      return null;
    }

    const issuer = await context.loaders.issuerById.load(credential.issuerId);

    return issuer ? mapIssuer(issuer) : null;
  }

  @ResolveField(() => [GqlCredentialAttribute])
  async attributes(
    @Parent() credential: GqlCredential,
    @Context() context: GraphqlContext
  ): Promise<GqlCredentialAttribute[]> {
    const attributes = await context.loaders.attributesByCredentialId.load(credential.id);

    return attributes.map((attribute) => mapCredentialAttribute(attribute, credential.holderId));
  }
}

@Resolver(() => GqlCredentialAttribute)
export class CredentialAttributeFieldResolver {
  constructor(private readonly policy: GraphqlPolicyService) {}

  @ResolveField(() => String, { nullable: true })
  value(
    @Parent() attribute: GqlCredentialAttribute,
    @Context() context: GraphqlContext
  ): string | null {
    if (!attribute.sensitive) {
      return attribute.value;
    }

    return this.policy.canReadSensitiveCredentialField(
      context.identity,
      attribute.credentialHolderId
    )
      ? attribute.value
      : null;
  }
}
