/**
 * Answers one customer's DM with the workspace's AI assistant.
 *
 * Safe to run more than once for the same message: the newest customer
 * message is claimed atomically on the thread before anything is sent.
 */
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  getConversationWithUser,
  sendDirectMessage,
  sendDirectMessageWithLinkButton,
  type InstagramMessage,
} from "@/lib/meta/client";
import { generateAssistantReply, type HistoryMessage } from "./reply";
import type { ProcessAssistantJob } from "@/lib/queue/client";

/**
 * WhatsApp link with the order summary pre-written, so the conversation on
 * WhatsApp (a person or the TICO ARM agent) starts with what the customer
 * wants. Only wa.me / api.whatsapp.com links get the text; others are kept.
 */
export function whatsappLinkWithMessage(url: string, summary: string, username?: string | null): string {
  try {
    const link = new URL(url);
    if (!["wa.me", "api.whatsapp.com"].includes(link.hostname)) return url;
    const intro = username ? `Hola, vengo de Instagram (@${username}).` : "Hola, vengo de Instagram.";
    const text = summary.trim() ? `${intro} ${summary.trim()}` : intro;
    link.searchParams.set("text", text.slice(0, 500));
    return link.toString();
  } catch {
    return url;
  }
}

// Meta only allows replies within 24 h of the customer's last message.
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Never answer a backlog: only messages from the last few minutes.
const MAX_MESSAGE_AGE_MS = Number(process.env.ASSISTANT_MAX_MESSAGE_AGE_MS ?? 15 * 60_000);
// Guard against loops with another bot or a very long chat.
const MAX_REPLIES_PER_HOUR = 20;

export type AssistantOutcome =
  | "disabled" | "paused" | "no_message" | "stale" | "already_handled"
  | "keyword_campaign" | "rate_limited" | "replied" | "handoff";

export async function processAssistantJob(job: ProcessAssistantJob, now = Date.now()): Promise<AssistantOutcome> {
  const account = await prisma.instagramAccount.findUnique({
    where: { id: job.accountConnectionId },
    select: {
      id: true, instagramId: true, username: true, provider: true, accessToken: true, workspaceId: true,
      workspace: { select: { name: true, assistantConfig: true } },
    },
  });
  const config = account?.workspace.assistantConfig;
  if (!account || account.provider !== "META" || !account.accessToken || !config?.enabled) return "disabled";

  const thread = await prisma.assistantThread.upsert({
    where: { instagramAccountId_userId: { instagramAccountId: account.id, userId: job.userId } },
    create: { workspaceId: account.workspaceId, instagramAccountId: account.id, userId: job.userId },
    update: {},
  });
  if (thread.paused) return "paused";

  const token = decryptToken(account.accessToken);
  const conversation = await getConversationWithUser(token, account.instagramId, job.userId);
  const messages: InstagramMessage[] = conversation?.messages?.data ?? [];
  const latest = messages[0];
  if (!latest || latest.from?.id === account.instagramId || !latest.message?.trim()) return "no_message";

  const sentAt = latest.created_time ? Date.parse(latest.created_time) : now;
  if (now - sentAt > MAX_MESSAGE_AGE_MS || now - sentAt > REPLY_WINDOW_MS) return "stale";

  // A keyword DM campaign already answered this message.
  const campaignReply = await prisma.dmLog.findFirst({ where: { commentId: `dm:${latest.id}` }, select: { id: true } });
  if (campaignReply) return "keyword_campaign";

  if (
    thread.lastReplyAt &&
    now - thread.lastReplyAt.getTime() < 60 * 60_000 &&
    thread.replyCount >= MAX_REPLIES_PER_HOUR
  ) {
    return "rate_limited";
  }

  // Claim this message so concurrent jobs (webhook + polling) answer once.
  const claimed = await prisma.assistantThread.updateMany({
    where: {
      id: thread.id,
      paused: false,
      OR: [{ lastProcessedMessageId: null }, { lastProcessedMessageId: { not: latest.id } }],
    },
    data: { lastProcessedMessageId: latest.id, username: latest.from?.username ?? thread.username },
  });
  if (claimed.count === 0) return "already_handled";

  const history: HistoryMessage[] = [...messages]
    .reverse()
    .filter((m) => m.message)
    .map((m) => ({ role: m.from?.id === account.instagramId ? "assistant" : "user", text: m.message! }));

  const decision = await generateAssistantReply({
    businessName: account.workspace.name || account.username,
    businessInfo: config.businessInfo,
    history,
  });

  const withinHour = thread.lastReplyAt && now - thread.lastReplyAt.getTime() < 60 * 60_000;
  const counters = { lastReplyAt: new Date(now), replyCount: withinHour ? { increment: 1 } : 1 };

  if (decision.handoff) {
    const text = [decision.reply, config.handoffMessage].map((t) => t.trim()).filter(Boolean).join("\n\n")
      || "Te paso con una persona del equipo para ayudarte.";
    if (config.whatsappUrl) {
      await sendDirectMessageWithLinkButton(token, account.instagramId, job.userId, text, [
        {
          title: "Escribir por WhatsApp",
          url: whatsappLinkWithMessage(config.whatsappUrl, decision.whatsappMessage, latest.from?.username ?? thread.username),
        },
      ]);
    } else {
      await sendDirectMessage(token, account.instagramId, job.userId, text);
    }
    await prisma.assistantThread.update({
      where: { id: thread.id },
      data: { ...counters, paused: true, pausedReason: "handoff" },
    });
    return "handoff";
  }

  await sendDirectMessage(token, account.instagramId, job.userId, decision.reply.slice(0, 1000));
  await prisma.assistantThread.update({ where: { id: thread.id }, data: counters });
  return "replied";
}
