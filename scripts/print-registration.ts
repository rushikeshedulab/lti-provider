import { env, toolEndpoints } from '../src/config/env.js';
import { defaultPlatformRegistration, toolRegistrationDocument } from '../src/config/registration.js';

console.log('\n=== TOOL REGISTRATION (give these to the LMS/platform admin) ===\n');
console.log(JSON.stringify({ ...toolRegistrationDocument, endpoints: toolEndpoints }, null, 2));

console.log('\n=== PLATFORM REGISTRATION (what this tool currently trusts) ===\n');
console.log(JSON.stringify(defaultPlatformRegistration, null, 2));

console.log('\nKey id in use:', env.keyId);
console.log('Public JWKS  :', toolEndpoints.jwksUrl, '\n');
