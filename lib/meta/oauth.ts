import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import {
  getEncryptionKeyHex,
  getMetaGraphApiVersion,
  isUnifiedLogin,
  requireEnv,
} from "@/lib/env";

// Instagram API with Instagram Login authorizes on www.instagram.com. The old
// api.instagram.com/oauth/authorize host belonged to the retired Basic Display
// API and now 404s ("Sorry, this page isn't available"), which looks like a bad
// link rather than a wrong endpoint. The token exchange below still lives on
// api.instagram.com — only the authorize hop moved.
const INSTAGRAM_OAUTH_URL = "https://www.instagram.com/oauth/authorize";
const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

interface OAuthStatePayload {
  workspaceId: string;
  ts: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signState(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(payload)
    .digest("base64url");
}

export function createOAuthState(workspaceId: string): string {
  const payload = base64UrlEncode(
    JSON.stringify({ workspaceId, ts: Date.now() } satisfies OAuthStatePayload)
  );
  return `${payload}.${signState(payload)}`;
}

export function verifyOAuthState(state: string | null): OAuthStatePayload | null {
  if (!state) return null;

  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = signState(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as OAuthStatePayload;
    if (typeof parsed.workspaceId !== "string" || !parsed.workspaceId) {
      return null;
    }

    // Reject a missing or non-numeric timestamp. `Date.now() - "abc"` is NaN,
    // and every comparison against NaN is false, so a non-numeric ts would
    // otherwise pass the age check and never expire. A ts in the future is
    // rejected for the same reason: it has not aged at all.
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
      return null;
    }

    const age = Date.now() - parsed.ts;
    if (age < 0 || age > STATE_MAX_AGE_MS) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function getAuthorizationUrl(redirectUri: string, state: string): string {
  if (isUnifiedLogin()) {
    // Facebook Login for Business: the permissions come from the
    // configuration, so no scope is sent.
    const params = new URLSearchParams({
      client_id: requireEnv("META_APP_ID"),
      redirect_uri: redirectUri,
      config_id: requireEnv("META_LOGIN_CONFIG_ID"),
      response_type: "code",
      state,
    });
    return `https://www.facebook.com/${getMetaGraphApiVersion()}/dialog/oauth?${params.toString()}`;
  }

  const params = new URLSearchParams({
    client_id: requireEnv("INSTAGRAM_APP_ID"),
    redirect_uri: redirectUri,
    scope:
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_manage_insights",
    response_type: "code",
    state,
  });

  return `${INSTAGRAM_OAUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; userId: string }> {
  const body = new URLSearchParams({
    client_id: requireEnv("INSTAGRAM_APP_ID"),
    client_secret: requireEnv("INSTAGRAM_APP_SECRET"),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });

  const response = await fetch(INSTAGRAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Token exchange failed: ${error.error_message || JSON.stringify(error)}`
    );
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    userId: String(data.user_id),
  };
}

export interface UnifiedConnection {
  /** Page access token for the Page linked to the Instagram account. */
  accessToken: string;
  instagramId: string;
  username: string;
  name?: string;
  pageId: string;
}

interface FacebookPage {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string; name?: string };
}

async function readGraph<T>(url: URL): Promise<T> {
  const response = await fetch(url.toString());
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message ?? JSON.stringify(data);
    throw new Error(`Facebook Login failed: ${message}`);
  }
  return data as T;
}

/**
 * Unified Login code exchange. The short-lived user token becomes a long-lived
 * one, and a Page token read with a long-lived user token does not expire, so
 * the stored token never needs the refresh cron.
 */
export async function exchangeUnifiedCode(
  code: string,
  redirectUri: string
): Promise<UnifiedConnection> {
  const base = `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
  const appId = requireEnv("META_APP_ID");
  const appSecret = requireEnv("FACEBOOK_APP_SECRET");

  const shortUrl = new URL(`${base}/oauth/access_token`);
  shortUrl.searchParams.set("client_id", appId);
  shortUrl.searchParams.set("client_secret", appSecret);
  shortUrl.searchParams.set("redirect_uri", redirectUri);
  shortUrl.searchParams.set("code", code);
  const short = await readGraph<{ access_token: string }>(shortUrl);

  const longUrl = new URL(`${base}/oauth/access_token`);
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  longUrl.searchParams.set("client_id", appId);
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("fb_exchange_token", short.access_token);
  const long = await readGraph<{ access_token: string }>(longUrl);

  const pagesUrl = new URL(`${base}/me/accounts`);
  pagesUrl.searchParams.set(
    "fields",
    "id,name,access_token,instagram_business_account{id,username,name}"
  );
  pagesUrl.searchParams.set("limit", "100");
  pagesUrl.searchParams.set("access_token", long.access_token);
  const pages = await readGraph<{ data?: FacebookPage[] }>(pagesUrl);

  const list = pages.data ?? [];
  for (const candidate of list) {
    if (!candidate.access_token) continue;
    const ig =
      candidate.instagram_business_account ??
      (await readLinkedInstagram(base, candidate.id, candidate.access_token));
    if (ig?.id) {
      return {
        accessToken: candidate.access_token,
        instagramId: ig.id,
        username: ig.username ?? "",
        name: ig.name,
        pageId: candidate.id,
      };
    }
  }

  // Say what Meta actually returned, so a failed connect can be told apart:
  // no Page shared in the dialog vs. Pages without a linked Instagram account.
  const granted = await readGrantedPermissions(base, long.access_token);
  const pageSummary = list.length
    ? list.map((p) => `${p.name ?? p.id}${p.access_token ? "" : " (no token)"}`).join(", ")
    : "none";
  throw new Error(
    `No Facebook Page with a linked Instagram professional account was shared during login. Pages: ${pageSummary}. Permissions: ${granted}`
  );
}

type LinkedInstagram = { id: string; username?: string; name?: string };

// Read the Page itself with its own token. Some Pages only expose the linked
// account this way, and connected_instagram_account covers accounts linked
// from the Instagram side.
async function readLinkedInstagram(
  base: string,
  pageId: string,
  pageToken: string
): Promise<LinkedInstagram | undefined> {
  const url = new URL(`${base}/${pageId}`);
  url.searchParams.set(
    "fields",
    "instagram_business_account{id,username,name},connected_instagram_account{id,username,name}"
  );
  url.searchParams.set("access_token", pageToken);
  try {
    const data = await readGraph<{
      instagram_business_account?: LinkedInstagram;
      connected_instagram_account?: LinkedInstagram;
    }>(url);
    return data.instagram_business_account ?? data.connected_instagram_account;
  } catch {
    return undefined;
  }
}

async function readGrantedPermissions(base: string, userToken: string): Promise<string> {
  const url = new URL(`${base}/me/permissions`);
  url.searchParams.set("access_token", userToken);
  try {
    const data = await readGraph<{ data?: Array<{ permission: string; status: string }> }>(url);
    const granted = (data.data ?? [])
      .filter((p) => p.status === "granted")
      .map((p) => p.permission);
    return granted.length ? granted.join(",") : "none";
  } catch {
    return "unknown";
  }
}

function getEncryptionKey(): Buffer {
  return Buffer.from(getEncryptionKeyHex(), "hex");
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);

  return combined.toString("base64");
}

export function decryptToken(encryptedBase64: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(encryptedBase64, "base64");

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8"
  );
}
