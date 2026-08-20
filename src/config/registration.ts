import { env, toolEndpoints } from './env.js';

/**
 * PLATFORM REGISTRATION
 * ---------------------
 * In a real deployment an administrator pastes these values into the tool after
 * the LMS admin creates a developer key. Here they are checked in so the demo
 * boots with a working trust relationship, but every field is env-overridable.
 *
 * The matching half of this registration lives in the consumer project
 * (lti-consumer-lms/src/config/registration.ts) - the two MUST agree on
 * issuer, client_id, deployment_id and the endpoint URLs.
 */
const consumerBaseUrl = (process.env.CONSUMER_BASE_URL ?? 'http://localhost:4001').replace(/\/$/, '');

export const defaultPlatformRegistration = {
  name: process.env.PLATFORM_NAME ?? 'EduLab Consumer LMS',
  issuer: process.env.PLATFORM_ISSUER ?? consumerBaseUrl,
  clientId: process.env.LTI_CLIENT_ID ?? 'edulab-content-provider',
  deploymentIds: (process.env.LTI_DEPLOYMENT_IDS ?? 'deployment-fin-001').split(',').map((s) => s.trim()),
  authLoginUrl: process.env.PLATFORM_AUTH_LOGIN_URL ?? `${consumerBaseUrl}/lti/authorize`,
  authTokenUrl: process.env.PLATFORM_AUTH_TOKEN_URL ?? `${consumerBaseUrl}/lti/token`,
  jwksUrl: process.env.PLATFORM_JWKS_URL ?? `${consumerBaseUrl}/.well-known/jwks.json`,
  toolRedirectUri: toolEndpoints.redirectUri,
};

/** Everything an LMS admin needs to register this tool. Printed by `npm run registration:print`. */
export const toolRegistrationDocument = {
  title: 'EduLab LTI Content Provider',
  description: 'Financial markets video lectures, delivered over LTI 1.3',
  oidc_initiation_url: toolEndpoints.loginInitiationUrl,
  target_link_uri: toolEndpoints.targetLinkUri,
  redirect_uris: [toolEndpoints.redirectUri],
  public_jwk_url: toolEndpoints.jwksUrl,
  key_id: env.keyId,
  scopes: [],
  extensions: [
    {
      platform: 'generic',
      privacy_level: 'public',
      messages: [
        { type: 'LtiResourceLinkRequest', target_link_uri: toolEndpoints.targetLinkUri },
        { type: 'LtiDeepLinkingRequest', target_link_uri: toolEndpoints.targetLinkUri },
      ],
    },
  ],
};
