import { NextResponse } from "next/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getBaseUrl, getMissingInstagramOAuthEnv } from "@/lib/env";
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_NONCE_COOKIE_PATH,
  OAUTH_STATE_MAX_AGE_SECONDS,
  createOAuthNonce,
  createOAuthState,
  getAuthorizationUrl,
} from "@/lib/meta/oauth";

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.redirect(`${getBaseUrl()}/login`);
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?instagram=forbidden`);
  }

  // getAuthorizationUrl and createOAuthState call requireEnv, which throws.
  // Without this check an incomplete .env surfaces as a 500 on a plain <a>
  // navigation, which reads to the user as the button doing nothing at all.
  const missingEnv = getMissingInstagramOAuthEnv();
  if (missingEnv.length > 0) {
    return NextResponse.redirect(
      `${getBaseUrl()}/settings?instagram=misconfigured&missing=${encodeURIComponent(
        missingEnv.join(",")
      )}`
    );
  }

  const redirectUri = `${getBaseUrl()}/api/instagram/callback`;
  // The state is bound to this user and to a nonce kept in an httpOnly cookie,
  // so a connect URL minted in one browser cannot complete in another.
  const nonce = createOAuthNonce();
  const state = createOAuthState(context.workspaceId, context.userId, nonce);

  const response = NextResponse.redirect(getAuthorizationUrl(redirectUri, state));
  response.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: redirectUri.startsWith("https://"),
    sameSite: "lax",
    path: OAUTH_NONCE_COOKIE_PATH,
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });
  return response;
}
