import type { AuthConfig, RoleConfig, DescribeAuthResult, SuccessCheck } from '../types.js';
import { resolveCredentials } from '../env/indirection.js';
import { log } from '../log.js';

const NEXTAUTH_DEFAULT_COOKIE = 'authjs.session-token';
const NEXTAUTH_DEFAULT_UI_PATH = '/api/auth/signin';

function buildFormResult(
  auth: Extract<AuthConfig, { kind: 'form' }>,
  role: RoleConfig
): Extract<DescribeAuthResult, { authKind: 'form' }> {
  const uiFieldMap = auth.uiLoginFields ?? auth.loginFields;
  const resolved = resolveCredentials(role.credentials!);

  const fields: Record<string, string> = { ...uiFieldMap };
  const values: Record<string, string> = {};

  for (const [credKey, domName] of Object.entries(uiFieldMap)) {
    if (!(credKey in resolved)) {
      log.warn({ role: role.name, credKey }, 'describe_auth: credential key missing from role credentials; value will be empty');
    }
    values[domName] = resolved[credKey] ?? '';
  }

  const successCheck: SuccessCheck = auth.successCheck;
  const cookieName = successCheck.kind === 'cookie' ? successCheck.name : undefined;

  return {
    authKind: 'form',
    uiLoginPath: auth.uiLoginPath ?? auth.loginPath,
    ...(auth.uiTriggerSelector !== undefined && { uiTriggerSelector: auth.uiTriggerSelector }),
    ...(auth.uiSubmitSelector !== undefined && { uiSubmitSelector: auth.uiSubmitSelector }),
    fields,
    values,
    successCheck,
    ...(cookieName !== undefined && { cookieName }),
  };
}

function buildNextAuthResult(
  auth: Extract<AuthConfig, { kind: 'nextauth' }>,
  role: RoleConfig
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

  const resolved = resolveCredentials(role.credentials!);
  const fields: Record<string, string> = { ...uiFieldMap };
  const values: Record<string, string> = {};

  for (const [credKey, domName] of Object.entries(uiFieldMap)) {
    if (!(credKey in resolved)) {
      log.warn({ role: role.name, credKey }, 'describe_auth: credential key missing from role credentials; value will be empty');
    }
    values[domName] = resolved[credKey] ?? '';
  }

  const cookieName = auth.cookieName ?? NEXTAUTH_DEFAULT_COOKIE;
  const successCheck: SuccessCheck = { kind: 'cookie', name: cookieName };

  return {
    authKind: 'nextauth',
    uiLoginPath: auth.uiLoginPath ?? NEXTAUTH_DEFAULT_UI_PATH,
    ...(auth.uiTriggerSelector !== undefined && { uiTriggerSelector: auth.uiTriggerSelector }),
    ...(auth.uiSubmitSelector !== undefined && { uiSubmitSelector: auth.uiSubmitSelector }),
    fields,
    values,
    successCheck,
    cookieName,
  };
}

export function buildDescribeAuth(
  auth: AuthConfig,
  role: RoleConfig
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
    case 'form':
      return buildFormResult(auth, role);
    case 'nextauth':
      return buildNextAuthResult(auth, role);
  }
}
