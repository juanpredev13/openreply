import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMissingInstagramOAuthEnv, isUnifiedLogin } from "../lib/env";
import {
  getAllUserMedia,
  getUserInfo,
  sendPrivateReply,
  subscribeInstagramAccountToWebhooks,
} from "../lib/meta/client";
import { exchangeUnifiedCode, getAuthorizationUrl } from "../lib/meta/oauth";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("legacy Instagram Login (default)", () => {
  it("is the default mode", () => {
    expect(isUnifiedLogin()).toBe(false);
  });

  it("keeps sending through graph.instagram.com with the account ID", async () => {
    fetchMock.mockResolvedValueOnce(json({ recipient_id: "1", message_id: "m" }));
    await sendPrivateReply("tok", "ig_1", "c_1", "hola");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://graph.instagram.com/v25.0/ig_1/messages"
    );
  });

  it("builds the Instagram authorize URL", () => {
    vi.stubEnv("INSTAGRAM_APP_ID", "ig_app");
    const url = new URL(getAuthorizationUrl("https://x.test/cb", "st"));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
  });
});

describe("Unified Login mode", () => {
  beforeEach(() => {
    vi.stubEnv("META_LOGIN_MODE", "unified");
    vi.stubEnv("META_APP_ID", "meta_app");
    vi.stubEnv("FACEBOOK_APP_SECRET", "fb_secret");
    vi.stubEnv("META_LOGIN_CONFIG_ID", "cfg_1");
  });

  it("requires the Meta app variables, not the Instagram ones", () => {
    expect(getMissingInstagramOAuthEnv()).toEqual([]);
    vi.stubEnv("META_LOGIN_CONFIG_ID", "");
    expect(getMissingInstagramOAuthEnv()).toEqual(["META_LOGIN_CONFIG_ID"]);
  });

  it("builds a Facebook Login for Business URL with config_id", () => {
    const url = new URL(getAuthorizationUrl("https://x.test/cb", "st"));
    expect(url.origin + url.pathname).toBe(
      "https://www.facebook.com/v25.0/dialog/oauth"
    );
    expect(url.searchParams.get("client_id")).toBe("meta_app");
    expect(url.searchParams.get("config_id")).toBe("cfg_1");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("exchanges the code and picks the Page linked to Instagram", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "short" }))
      .mockResolvedValueOnce(json({ access_token: "long" }))
      .mockResolvedValueOnce(
        json({
          data: [
            { id: "p0", access_token: "pt0" },
            {
              id: "p1",
              access_token: "page_token",
              instagram_business_account: { id: "ig_9", username: "juan" },
            },
          ],
        })
      );

    const result = await exchangeUnifiedCode("code", "https://x.test/cb");
    expect(result).toMatchObject({
      accessToken: "page_token",
      instagramId: "ig_9",
      username: "juan",
      pageId: "p1",
    });
    const first = new URL(String(fetchMock.mock.calls[0][0]));
    expect(first.host).toBe("graph.facebook.com");
    expect(first.searchParams.get("client_secret")).toBe("fb_secret");
    const second = new URL(String(fetchMock.mock.calls[1][0]));
    expect(second.searchParams.get("grant_type")).toBe("fb_exchange_token");
  });

  it("fails clearly when no Page has an Instagram account", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "short" }))
      .mockResolvedValueOnce(json({ access_token: "long" }))
      .mockResolvedValueOnce(json({ data: [{ id: "p0", access_token: "pt0" }] }));
    await expect(exchangeUnifiedCode("code", "https://x.test/cb")).rejects.toThrow(
      /No Facebook Page/
    );
  });

  it("sends messages through the Page on graph.facebook.com", async () => {
    fetchMock.mockResolvedValueOnce(json({ recipient_id: "1", message_id: "m" }));
    await sendPrivateReply("page_token", "ig_9", "c_1", "hola");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://graph.facebook.com/v25.0/me/messages"
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.recipient).toEqual({ comment_id: "c_1" });
  });

  it("subscribes the Page with Page fields", async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await subscribeInstagramAccountToWebhooks("ig_9", "page_token");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://graph.facebook.com/v25.0/me/subscribed_apps"
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.subscribed_fields).toEqual(["feed", "messages"]);
  });

  it("reads media and profile from the Instagram account ID", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ instagram_business_account: { id: "ig_7" } }))
      .mockResolvedValueOnce(json({ data: [{ id: "m1" }] }))
      .mockResolvedValueOnce(json({ id: "ig_7", username: "juan" }));

    const media = await getAllUserMedia("page_token_media", 10);
    expect(media).toHaveLength(1);
    expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toBe(
      "/v25.0/ig_7/media"
    );

    // The Instagram ID is cached per token, so no second lookup.
    const info = await getUserInfo("page_token_media");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(info).toMatchObject({ id: "ig_7", user_id: "ig_7", username: "juan" });
  });
});
