import type { AuthConfig, RoleConfig, DescribeAuthResult, SuccessCheck, CredentialFieldMeta } from '../types.js';
import { resolveCredentials } from '../env/indirection.js';
import { OAUTH2_CREDENTIAL_FIELDS, resolveOAuth2CredentialKeys } from './oauth2.js';
import { log } from '../log.js';

const NEXTAUTH_DEFAULT_COOKIE = 'authjs.session-token';
const NEXTAUTH_DEFAULT_UI_PATH = '/api/auth/signin';

/** Classify the provenance of a raw (pre-resolution) credential value. */
function credSource(raw: string | undefined): CredentialFieldMeta['source'] {
  if (raw === undefined) return 'missing';
  return /\$env:/i.test(raw) ? 'env' : 'literal';
}

/**
 * Build the per-field metadata + (optionally) plaintext values for a
 * `{ credentialKey -> domFieldName }` map. Values are only included when
 * `reveal` is true; metadata is always safe to return.
 */
function buildFieldData(
  uiFieldMap: Record<string, string>,
  rawCredentials: Record<string, string>,
  roleName: string,
  reveal: boolean
): { valueMeta: Record<string, CredentialFieldMeta>; values?: Record<string, string> } {
  const resolved = resolveCredentials(rawCredentials);
  const valueMeta: Record<string, CredentialFieldMeta> = {};
  const values: Record<string, string> = {};

  for (const [credKey, domName] of Object.entries(uiFieldMap)) {
    if (!(credKey in resolved)) {
      log.warn(
        { role: roleName, credKey },
        'describe_auth: credential key missing from role credentials; value will be empty'
      );
    }
    const resolvedValue = resolved[credKey] ?? '';
    valueMeta[domName] = {
      present: resolvedValue !== '',
      length: resolvedValue.length,
      source: credSource(rawCredentials[credKey]),
    };
    values[domName] = resolvedValue;
  }

  return reveal ? { valueMeta, values } : { valueMeta };
}

function buildFormResult(
  auth: Extract<AuthConfig, { kind: 'form' }>,
  role: RoleConfig,
  reveal: boolean
): Extract<DescribeAuthResult, { authKind: 'form' }> {
  const uiFieldMap = auth.uiLoginFields ?? auth.loginFields;
  const { valueMeta, values } = buildFieldData(uiFieldMap, role.credentials!, role.name, reveal);

  const successCheck: SuccessCheck = auth.successCheck;
  const cookieName = successCheck.kind === 'cookie' ? successCheck.name : undefined;

  return {
    authKind: 'form',
    uiLoginPath: auth.uiLoginPath ?? auth.loginPath,
    ...(auth.uiTriggerSelector !== undefined && { uiTriggerSelector: auth.uiTriggerSelector }),
    ...(auth.uiSubmitSelector !== undefined && { uiSubmitSelector: auth.uiSubmitSelector }),
    fields: { ...uiFieldMap },
    valueMeta,
    ...(values !== undefined && { values }),
    redacted: !reveal,
    successCheck,
    ...(cookieName !== undefined && { cookieName }),
  };
}

function buildNextAuthResult(
  auth: Extract<AuthConfig, { kind: 'nextauth' }>,
  role: RoleConfig,
  reveal: boolean
): Extract<DescribeAuthResult, { authKind: 'nextauth' }> {
  // auth.fields orientation is { postFieldName: credentialKey } — invert to { credKey: domName }
  let uiFieldMap: Record<string, string>;
  if (auth.uiLoginFields) {
    uiFieldMap = auth.uiLoginFields;
  } else {
    uiFieldMap = {};
    for (const [postName, credKey] of Object.entries(auth.fields)) {
      uiFieldMap[credKey] = postName;
    }
  }

  const { valueMeta, values } = buildFieldData(uiFieldMap, role.credentials!, role.name, reveal);

  const cookieName = auth.cookieName ?? NEXTAUTH_DEFAULT_COOKIE;
  const successCheck: SuccessCheck = { kind: 'cookie', name: cookieName };

  return {
    authKind: 'nextauth',
    uiLoginPath: auth.uiLoginPath ?? NEXTAUTH_DEFAULT_UI_PATH,
    ...(auth.uiTriggerSelector !== undefined && { uiTriggerSelector: auth.uiTriggerSelector }),
    ...(auth.uiSubmitSelector !== undefined && { uiSubmitSelector: auth.uiSubmitSelector }),
    fields: { ...uiFieldMap },
    valueMeta,
    ...(values !== undefined && { values }),
    redacted: !reveal,
    successCheck,
    cookieName,
  };
}

/**
 * OAuth2 client-credentials: report the non-secret shape of the token request
 * (endpoint, grant, client-auth style, scope/audience) plus which role credential
 * key supplies each field and its `valueMeta`.
 *
 * The client secret is NEVER included — not even under `revealSecrets`. Unlike
 * form/nextauth there is no browser login for a caller to drive with it, so
 * revealing it would be disclosure with no consumer. Access tokens live only on
 * the session and are likewise never described here.
 */
function buildOAuth2Result(
  auth: Extract<AuthConfig, { kind: 'oauth2' }>,
  role: RoleConfig
): Extract<DescribeAuthResult, { authKind: 'oauth2' }> {
  const rawCredentials = role.credentials!;
  const credKeys = resolveOAuth2CredentialKeys(rawCredentials);

  // buildFieldData maps { credentialKey -> reportedName }; for oauth2 the
  // reported name is the canonical field. A field the role does not declare is
  // keyed by its canonical name so it reports source: 'missing'.
  const fieldMap: Record<string, string> = {};
  for (const field of OAUTH2_CREDENTIAL_FIELDS) {
    fieldMap[credKeys[field] ?? field] = field;
  }

  // reveal: false — hard-coded, see the note above.
  const { valueMeta } = buildFieldData(fieldMap, rawCredentials, role.name, false);

  return {
    authKind: 'oauth2',
    reason: 'programmatic_only',
    detail:
      'OAuth2 client-credentials auth cannot drive a browser; skip browser login. Tokens are minted from the token endpoint and sent as an Authorization header.',
    tokenUrl: auth.tokenUrl,
    grantType: auth.grantType ?? 'client_credentials',
    clientAuth: auth.clientAuth ?? 'basic',
    ...(auth.scope !== undefined && { scope: auth.scope }),
    ...(auth.audience !== undefined && { audience: auth.audience }),
    fields: { ...fieldMap },
    valueMeta,
    redacted: true,
  };
}

/**
 * Build the auth description for a role.
 *
 * Credential VALUES are redacted by default: only field names and per-field
 * shape metadata (`valueMeta`) are returned. Pass `revealSecrets: true` to
 * additionally include the plaintext `values` map. The caller is responsible
 * for gating `revealSecrets` behind loopback + the token gate.
 */
export function buildDescribeAuth(
  auth: AuthConfig,
  role: RoleConfig,
  revealSecrets = false
): DescribeAuthResult {
  if (!role.credentials || Object.keys(role.credentials).length === 0) {
    return { authKind: 'anonymous', reason: 'role_has_no_credentials' };
  }

  switch (auth.kind) {
    case 'none':
      return { authKind: 'none', reason: 'no_auth_configured' };
    case 'bearer':
      return { authKind: 'bearer', reason: 'programmatic_only', detail: 'Bearer-token auth cannot drive a browser; skip browser login.' };
    case 'api_key':
      return { authKind: 'api_key', reason: 'programmatic_only', detail: 'API-key auth cannot drive a browser; skip browser login.' };
    case 'oauth2':
      // revealSecrets deliberately not threaded through: see buildOAuth2Result.
      return buildOAuth2Result(auth, role);
    case 'form':
      return buildFormResult(auth, role, revealSecrets);
    case 'nextauth':
      return buildNextAuthResult(auth, role, revealSecrets);
  }
}
