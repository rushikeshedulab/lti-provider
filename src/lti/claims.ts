/**
 * LTI 1.3 claim URIs (IMS Global / 1EdTech).
 * Every LTI-specific claim in the id_token is namespaced by one of these.
 */
export const CLAIM = {
  MESSAGE_TYPE: 'https://purl.imsglobal.org/spec/lti/claim/message_type',
  VERSION: 'https://purl.imsglobal.org/spec/lti/claim/version',
  DEPLOYMENT_ID: 'https://purl.imsglobal.org/spec/lti/claim/deployment_id',
  TARGET_LINK_URI: 'https://purl.imsglobal.org/spec/lti/claim/target_link_uri',
  RESOURCE_LINK: 'https://purl.imsglobal.org/spec/lti/claim/resource_link',
  CONTEXT: 'https://purl.imsglobal.org/spec/lti/claim/context',
  ROLES: 'https://purl.imsglobal.org/spec/lti/claim/roles',
  TOOL_PLATFORM: 'https://purl.imsglobal.org/spec/lti/claim/tool_platform',
  LAUNCH_PRESENTATION: 'https://purl.imsglobal.org/spec/lti/claim/launch_presentation',
  CUSTOM: 'https://purl.imsglobal.org/spec/lti/claim/custom',
  LIS: 'https://purl.imsglobal.org/spec/lti/claim/lis',
  // Deep Linking
  DEEP_LINKING_SETTINGS: 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings',
  CONTENT_ITEMS: 'https://purl.imsglobal.org/spec/lti-dl/claim/content_items',
  DEEP_LINKING_DATA: 'https://purl.imsglobal.org/spec/lti-dl/claim/data',
} as const;

export const MESSAGE_TYPE = {
  RESOURCE_LINK_REQUEST: 'LtiResourceLinkRequest',
  DEEP_LINKING_REQUEST: 'LtiDeepLinkingRequest',
  DEEP_LINKING_RESPONSE: 'LtiDeepLinkingResponse',
} as const;

export const LTI_VERSION = '1.3.0';

export const ROLE = {
  LEARNER: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
  INSTRUCTOR: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  ADMIN: 'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator',
} as const;

export interface LtiIdTokenClaims {
  iss: string;
  aud: string | string[];
  azp?: string;
  sub: string;
  exp: number;
  iat: number;
  nonce: string;
  jti?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  picture?: string;
  [key: string]: unknown;
}

export interface ResourceLinkClaim {
  id: string;
  title?: string;
  description?: string;
}

export interface ContextClaim {
  id: string;
  label?: string;
  title?: string;
  type?: string[];
}

export interface DeepLinkingSettingsClaim {
  deep_link_return_url: string;
  accept_types: string[];
  accept_presentation_document_targets: string[];
  accept_multiple?: boolean;
  auto_create?: boolean;
  title?: string;
  data?: string;
}

/** Convenience readers - keep the ugly URIs out of business logic. */
export function getClaim<T = unknown>(claims: LtiIdTokenClaims, uri: string): T | undefined {
  return claims[uri] as T | undefined;
}

export function getCustom(claims: LtiIdTokenClaims): Record<string, string> {
  return (getClaim<Record<string, string>>(claims, CLAIM.CUSTOM) ?? {}) as Record<string, string>;
}

export function getRoles(claims: LtiIdTokenClaims): string[] {
  return getClaim<string[]>(claims, CLAIM.ROLES) ?? [];
}

export function isInstructorOrAdmin(claims: LtiIdTokenClaims): boolean {
  const roles = getRoles(claims);
  return roles.some((r) => r === ROLE.INSTRUCTOR || r === ROLE.ADMIN || /#(Instructor|Administrator)$/.test(r));
}
