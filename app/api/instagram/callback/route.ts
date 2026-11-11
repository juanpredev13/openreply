import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl, isUnifiedLogin } from "@/lib/env";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import { getLongLivedToken, getUserInfo, subscribeInstagramAccountToWebhooks } from "@/lib/meta/client";
import {
  encryptToken,
  exchangeCodeForToken,
  exchangeUnifiedCode,
  verifyOAuthState,
} from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

interface ConnectedAccount {
  accessToken: string;
  instagramId: string;
  username: string;
  name?: string;
  tokenExpiresAt: Date | null;
}

async function connectWithInstagramLogin(
  code: string,
  redirectUri: string
): Promise<ConnectedAccount> {
  const { accessToken: shortLivedToken } = await exchangeCodeForToken(
    code,
    redirectUri
  );
  const { accessToken, expiresIn } = await getLongLivedToken(shortLivedToken);
  const userInfo = await getUserInfo(accessToken);
  // Webhooks and the messaging API key off the professional account ID
  // (user_id), not the app-scoped `id`. Store user_id so comment webhooks
  // can be matched back to this account. Fall back to id if user_id is
  // ever absent.
  return {
    accessToken,
    instagramId: userInfo.user_id ?? userInfo.id,
    username: userInfo.username,
    name: userInfo.name,
    tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

// Page tokens obtained through a long-lived user token do not expire, so the
// account is stored with no expiry and the refresh cron skips it.
async function connectWithUnifiedLogin(
  code: string,
  redirectUri: string
): Promise<ConnectedAccount> {
  const unified = await exchangeUnifiedCode(code, redirectUri);
  let { username, name } = unified;
  if (!username) {
    const info = await getUserInfo(unified.accessToken);
    username = info.username;
    name = name ?? info.name;
  }
  return {
    accessToken: unified.accessToken,
    instagramId: unified.instagramId,
    username,
    name,
    tokenExpiresAt: null,
  };
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  const baseUrl = getBaseUrl();

  if (error) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=invalid`);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: state.workspaceId,
      userId: session.user.id,
    },
  });

  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=forbidden`);
  }

  try {
    const redirectUri = `${baseUrl}/api/instagram/callback`;
    const { accessToken, instagramId, username, name, tokenExpiresAt } =
      isUnifiedLogin()
        ? await connectWithUnifiedLogin(code, redirectUri)
        : await connectWithInstagramLogin(code, redirectUri);
    const connection = await canConnectInstagramAccount({
      workspaceId: state.workspaceId,
      instagramId,
    });

    if (!connection.allowed) {
      return NextResponse.redirect(
        `${baseUrl}/settings?instagram=already_connected`
      );
    }

    const encryptedToken = encryptToken(accessToken);

    let webhookSubscribed = false;
    try {
      const subscription = await subscribeInstagramAccountToWebhooks(
        instagramId,
        accessToken
      );
      webhookSubscribed = Boolean(subscription.success);
    } catch (subscriptionError) {
      console.warn(
        "[Instagram Callback] Webhook subscription failed:",
        subscriptionError
      );
    }

    const data = {
      username,
      name,
      accessToken: encryptedToken,
      tokenExpiresAt,
      webhookSubscribed,
    };
    const existing = await prisma.instagramAccount.findUnique({ where: { instagramId } });
    if (existing) {
      const updated = await prisma.instagramAccount.updateMany({
        where: { id: existing.id, workspaceId: state.workspaceId, provider: 'META' }, data,
      });
      if (!updated.count) return NextResponse.redirect(`${baseUrl}/settings?instagram=already_connected`);
    } else {
      await prisma.instagramAccount.create({ data: { ...data, workspaceId: state.workspaceId, instagramId, provider: 'META' } });
    }

    return NextResponse.redirect(`${baseUrl}/dashboard?connected=true`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Instagram Callback] Error:", err);
    // The message is the only diagnostic a self-hoster gets for a failed
    // connect, so persist it alongside the other operational events rather
    // than leaving it in server logs they may not be able to reach.
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Instagram connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});

    return NextResponse.redirect(
      `${baseUrl}/settings?instagram=failed&reason=${encodeURIComponent(
        message.slice(0, 200)
      )}`
    );
  }
}
