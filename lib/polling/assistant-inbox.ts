/**
 * Polls the DM inbox for workspaces whose AI assistant is on.
 *
 * Message webhooks only reach this app once Meta grants Advanced Access and
 * the Page is subscribed, so until then the worker reads each account's most
 * recent conversations every few seconds and queues the ones whose newest
 * message is a recent, unanswered customer message. processAssistantJob does
 * the real checks and the atomic claim, so a duplicate queue entry is harmless.
 */
import { prisma } from "@/lib/db/client";
import { ASSISTANT_JOB_NAME, getDMQueue } from "@/lib/queue/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getConversations } from "@/lib/meta/client";

const MAX_MESSAGE_AGE_MS = Number(process.env.ASSISTANT_MAX_MESSAGE_AGE_MS ?? 15 * 60_000);

export interface AssistantPollResult {
  accounts: number;
  enqueued: number;
  errors: string[];
}

export async function pollAssistantInbox(now = Date.now()): Promise<AssistantPollResult> {
  const result: AssistantPollResult = { accounts: 0, enqueued: 0, errors: [] };
  const accounts = await prisma.instagramAccount.findMany({
    where: { provider: "META", workspace: { assistantConfig: { enabled: true } } },
    select: { id: true, instagramId: true, accessToken: true },
  });
  result.accounts = accounts.length;
  if (!accounts.length) return result;

  const queue = getDMQueue();
  for (const account of accounts) {
    if (!account.accessToken) continue;
    try {
      const conversations = await getConversations(decryptToken(account.accessToken), account.instagramId);
      const threads = await prisma.assistantThread.findMany({
        where: { instagramAccountId: account.id },
        select: { userId: true, paused: true, lastProcessedMessageId: true },
      });
      const byUser = new Map(threads.map((t) => [t.userId, t]));

      for (const conversation of conversations) {
        const latest = conversation.messages?.data?.[0];
        const userId = latest?.from?.id;
        if (!latest || !userId || userId === account.instagramId || !latest.message) continue;
        const sentAt = latest.created_time ? Date.parse(latest.created_time) : 0;
        if (now - sentAt > MAX_MESSAGE_AGE_MS) continue;
        const thread = byUser.get(userId);
        if (thread?.paused || thread?.lastProcessedMessageId === latest.id) continue;

        await queue.add(
          ASSISTANT_JOB_NAME,
          { accountConnectionId: account.id, userId },
          { jobId: `assistant_${account.id}_${Buffer.from(latest.id).toString("base64url")}` }
        );
        result.enqueued += 1;
      }
    } catch (error) {
      result.errors.push(`${account.id}: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
  return result;
}
