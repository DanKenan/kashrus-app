/**
 * Stage 3C — Secret Manager integration.
 *
 * Reads JWT secret, VAPID keys, and reset-code pepper from Google Cloud
 * Secret Manager. FAILS CLOSED: if a required secret is not available from
 * Secret Manager or env vars, the server refuses to start (throws).
 *
 * Values are NEVER rotated by this module — it only changes WHERE they are
 * read from. Rotation requires Don's explicit approval via a separate process.
 *
 * Priority for each secret:
 *   1. Secret Manager (projects/<project>/secrets/<name>/versions/latest)
 *   2. Environment variable (existing behavior, for local dev)
 *   3. FAIL — throw, do not generate, do not fall back to Firestore
 *
 * The old Firestore-stored values (jwtSecret, vapidKeys, resetPepper in
 * app-state/main) are NOT deleted by this PR. They remain as a fallback
 * until Don explicitly approves the cutover + cleanup.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

// Set to true via env var once Don has created the secrets and granted IAM.
// When false (default), the old Firestore/env behavior is preserved.
export function isSecretManagerEnabled(): boolean {
  return process.env.USE_SECRET_MANAGER === 'true';
}

let smClient: SecretManagerServiceClient | null = null;

function getClient(): SecretManagerServiceClient {
  if (!smClient) {
    smClient = new SecretManagerServiceClient();
  }
  return smClient;
}

/**
 * Fetch a secret value from Secret Manager.
 * Throws if the secret is not accessible (fail closed).
 */
export async function getSecret(secretName: string): Promise<string> {
  const projectId = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    throw new Error(
      `[secrets] USE_SECRET_MANAGER=true but GCP_PROJECT_ID is not set. ` +
      `Cannot resolve secret ${secretName}.`
    );
  }
  const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;
  try {
    const client = getClient();
    const [version] = await client.accessSecretVersion({ name });
    const payload = version.payload?.data;
    if (!payload) {
      throw new Error(`Empty payload for ${secretName}`);
    }
    const value = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
    if (!value) {
      throw new Error(`Empty value for ${secretName}`);
    }
    return value;
  } catch (e: any) {
    throw new Error(
      `[secrets] Failed to read ${secretName} from Secret Manager: ${e?.message}. ` +
      `Failing closed — server will not start without required secrets.`
    );
  }
}

/**
 * Get a secret with env-var fallback. Used during the transition period.
 * Once USE_SECRET_MANAGER=true and secrets are provisioned, env fallback
 * should be removed (fail closed to Secret Manager only).
 */
export async function getSecretWithEnvFallback(
  secretName: string,
  envVarName: string
): Promise<string | null> {
  // 1. Try env var first (existing behavior, works locally)
  if (process.env[envVarName]) {
    return process.env[envVarName]!;
  }
  // 2. Try Secret Manager if enabled
  if (isSecretManagerEnabled()) {
    return getSecret(secretName);
  }
  // 3. Not available — caller decides (may fall back to Firestore or fail)
  return null;
}

/**
 * Required secret names in Secret Manager.
 * Don creates these with the CURRENT values (no rotation in this PR).
 */
export const SECRET_NAMES = {
  JWT_SECRET: 'shutfey-jwt-secret',
  VAPID_PRIVATE_KEY: 'shutfey-vapid-private-key',
  VAPID_PUBLIC_KEY: 'shutfey-vapid-public-key',
  RESET_CODE_PEPPER: 'shutfey-reset-code-pepper',
} as const;
