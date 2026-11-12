/**
 * Instagram Live comment polling.
 *
 * Private replies to live comments are only accepted while the broadcast is on
 * air, so the 5-minute reconciler is far too slow for lives. Meta's real-time
 * `live_comments` webhook needs Advanced Access (App Review), which this app
 * does not have yet. Until then the worker polls, but only for accounts that
 * have at least one active campaign with matchLive:
 *   - every LIVE_CHECK_INTERVAL_MS it asks whether the account is live;
 *   - while it is live, every tick it reads the broadcast's comments and
 *     enqueues the new ones as regular comment jobs (isLive: true).
 * Matching, sending, dedupe and rate limits stay in the worker's processComment.
 */

import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getLiveComments, getLiveMedia, type InstagramLiveMedia } from "@/lib/meta/client";

const LIVE_CHECK_INTERVAL_MS = Number(process.env.LIVE_CHECK_INTERVAL_MS ?? 30_000);
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;

interface AccountState {
  lastLiveCheck: number;
  live: InstagramLiveMedia[];
}

const accountState = new Map<string, AccountState>();
// commentId -> first seen time, so a comment is enqueued once per process.
const seenComments = new Map<string, number>();

export interface LivePollResult {
  accounts: number;
  live: number;
  enqueued: number;
  errors: string[];
}

function forgetOldComments(now: number) {
  for (const [id, seenAt] of seenComments) {
    if (now - seenAt > SEEN_TTL_MS) seenComments.delete(id);
  }
}

export async function pollLiveComments(now = Date.now()): Promise<LivePollResult> {
  const result: LivePollResult = { accounts: 0, live: 0, enqueued: 0, errors: [] };

  const accounts = await prisma.instagramAccount.findMany({
    where: {
      provider: "META",
      automations: { some: { isActive: true, matchLive: true } },
    },
    select: { id: true, instagramId: true, accessToken: true },
  });
  result.accounts = accounts.length;
  if (accounts.length === 0) {
    accountState.clear();
    return result;
  }

  const queue = getDMQueue();
  for (const account of accounts) {
    if (!account.accessToken) continue;
    try {
      const token = decryptToken(account.accessToken);
      const state = accountState.get(account.id) ?? { lastLiveCheck: 0, live: [] };
      if (now - state.lastLiveCheck >= LIVE_CHECK_INTERVAL_MS) {
        state.live = await getLiveMedia(token);
        state.lastLiveCheck = now;
        accountState.set(account.id, state);
      }
      if (state.live.length === 0) continue;
      result.live += state.live.length;

      for (const media of state.live) {
        const comments = await getLiveComments(token, media.id);
        for (const comment of comments) {
          const commenterId = comment.from?.id;
          if (!commenterId || commenterId === account.instagramId) continue;
          if (seenComments.has(comment.id)) continue;
          seenComments.set(comment.id, now);
          await queue.add(
            "process-comment",
            {
              instagramAccountId: account.instagramId,
              accountConnectionId: account.id,
              commentId: comment.id,
              commentText: comment.text ?? "",
              commenterId,
              commenterName: comment.from?.username,
              mediaId: media.id,
              isLive: true,
              source: "POLLING",
            },
            // Same id the webhook path uses, so both paths dedupe each other.
            { jobId: `comment_${account.instagramId}_${comment.id}` }
          );
          result.enqueued += 1;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      result.errors.push(`${account.id}: ${message}`);
      // Back off: do not re-ask whether this account is live until the next check.
      accountState.set(account.id, { lastLiveCheck: now, live: [] });
    }
  }

  forgetOldComments(now);
  return result;
}
