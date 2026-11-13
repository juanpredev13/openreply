import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  account: null as Record<string, unknown> | null,
  thread: null as Record<string, unknown> | null,
  claimCount: 1,
  campaignLog: null as unknown,
  messages: [] as Array<{ id: string; created_time?: string; from?: { id: string; username?: string }; message?: string }>,
  decision: { reply: "Cuesta ₡12 500.", handoff: false },
  sent: [] as Array<{ kind: string; text: string; buttons?: unknown }>,
  threadUpdates: [] as Array<Record<string, unknown>>,
  jobs: [] as Array<{ name: string; data: Record<string, unknown>; opts: Record<string, unknown> }>,
  conversations: [] as unknown[],
  parse: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    instagramAccount: {
      findUnique: vi.fn(async () => h.account),
      findMany: vi.fn(async () => (h.account ? [h.account] : [])),
    },
    assistantThread: {
      upsert: vi.fn(async () => h.thread),
      updateMany: vi.fn(async () => ({ count: h.claimCount })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.threadUpdates.push(data); return {}; }),
      findMany: vi.fn(async () => (h.thread ? [h.thread] : [])),
    },
    dmLog: { findFirst: vi.fn(async () => h.campaignLog) },
  },
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (v: string) => `plain-${v}` }));
vi.mock("@/lib/meta/client", () => ({
  getConversationWithUser: vi.fn(async () => ({ id: "conv", messages: { data: h.messages } })),
  getConversations: vi.fn(async () => h.conversations),
  sendDirectMessage: vi.fn(async (_t: string, _ig: string, _u: string, text: string) => { h.sent.push({ kind: "text", text }); return {}; }),
  sendDirectMessageWithLinkButton: vi.fn(async (_t: string, _ig: string, _u: string, text: string, buttons: unknown) => { h.sent.push({ kind: "button", text, buttons }); return {}; }),
}));
vi.mock("@/lib/queue/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/queue/client")>()),
  getDMQueue: () => ({ add: vi.fn(async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => { h.jobs.push({ name, data, opts }); }) }),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { beta = { messages: { parse: h.parse } }; },
}));

import { processAssistantJob } from "../lib/assistant/process";
import { generateAssistantReply, normalizeHistory } from "../lib/assistant/reply";
import { pollAssistantInbox } from "../lib/polling/assistant-inbox";

const NOW = Date.parse("2026-11-12T20:00:00Z");
const recent = new Date(NOW - 60_000).toISOString();

beforeEach(() => {
  h.account = {
    id: "acc", instagramId: "ig_shop", username: "kbeauty", provider: "META", accessToken: "enc", workspaceId: "ws",
    workspace: { name: "Kbeauty", assistantConfig: { enabled: true, businessInfo: "Crema: ₡12 500", handoffMessage: "Escríbenos por WhatsApp.", whatsappUrl: "https://wa.me/50688888888" } },
  };
  h.thread = { id: "t1", userId: "u1", paused: false, lastProcessedMessageId: null, lastReplyAt: null, replyCount: 0, username: null };
  h.claimCount = 1;
  h.campaignLog = null;
  h.messages = [
    { id: "m2", created_time: recent, from: { id: "u1", username: "ana" }, message: "¿Cuánto cuesta la crema?" },
    { id: "m1", created_time: recent, from: { id: "ig_shop" }, message: "¡Hola! ¿En qué te ayudo?" },
  ];
  h.sent = [];
  h.threadUpdates = [];
  h.jobs = [];
  h.conversations = [];
  h.parse.mockReset();
  h.parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { reply: "Cuesta ₡12 500.", handoff: false } });
});

describe("conversation history", () => {
  it("merges consecutive turns and starts with the customer", () => {
    expect(normalizeHistory([
      { role: "assistant", text: "Bienvenida" },
      { role: "user", text: "hola" },
      { role: "user", text: "precio?" },
      { role: "assistant", text: "₡12 500" },
    ])).toEqual([
      { role: "user", content: "hola\nprecio?" },
      { role: "assistant", content: "₡12 500" },
    ]);
  });
});

describe("generateAssistantReply", () => {
  it("sends business info as cached system text and returns the parsed decision", async () => {
    const decision = await generateAssistantReply({ businessName: "Kbeauty", businessInfo: "Crema: ₡12 500", history: [{ role: "user", text: "precio?" }] });
    expect(decision).toEqual({ reply: "Cuesta ₡12 500.", handoff: false });
    const params = h.parse.mock.calls[0][0];
    expect(params.system[1]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(params.system[1].text).toContain("Crema: ₡12 500");
    expect(params.fallbacks).toBe("default");
  });

  it("hands off instead of improvising when the model declines", async () => {
    h.parse.mockResolvedValue({ stop_reason: "refusal", parsed_output: null });
    expect(await generateAssistantReply({ businessName: "K", businessInfo: "", history: [{ role: "user", text: "x" }] }))
      .toEqual({ reply: "", handoff: true });
  });
});

describe("processAssistantJob", () => {
  const job = { accountConnectionId: "acc", userId: "u1" };

  it("answers the customer's latest message with the full history", async () => {
    expect(await processAssistantJob(job, NOW)).toBe("replied");
    expect(h.sent).toEqual([{ kind: "text", text: "Cuesta ₡12 500." }]);
    const messages = h.parse.mock.calls[0][0].messages;
    expect(messages.at(-1)).toEqual({ role: "user", content: "¿Cuánto cuesta la crema?" });
  });

  it("hands off with the WhatsApp button and pauses the conversation", async () => {
    h.parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { reply: "Te paso con el equipo.", handoff: true } });
    expect(await processAssistantJob(job, NOW)).toBe("handoff");
    expect(h.sent[0]).toMatchObject({ kind: "button", text: "Te paso con el equipo.\n\nEscríbenos por WhatsApp.", buttons: [{ title: "Escribir por WhatsApp", url: "https://wa.me/50688888888" }] });
    expect(h.threadUpdates[0]).toMatchObject({ paused: true, pausedReason: "handoff" });
  });

  it("stays silent when it should", async () => {
    (h.account!.workspace as { assistantConfig: { enabled: boolean } }).assistantConfig.enabled = false;
    expect(await processAssistantJob(job, NOW)).toBe("disabled");
    (h.account!.workspace as { assistantConfig: { enabled: boolean } }).assistantConfig.enabled = true;

    h.thread!.paused = true;
    expect(await processAssistantJob(job, NOW)).toBe("paused");
    h.thread!.paused = false;

    h.messages[0].created_time = new Date(NOW - 2 * 60 * 60_000).toISOString();
    expect(await processAssistantJob(job, NOW)).toBe("stale");
    h.messages[0].created_time = recent;

    h.campaignLog = { id: "log" };
    expect(await processAssistantJob(job, NOW)).toBe("keyword_campaign");
    h.campaignLog = null;

    h.claimCount = 0;
    expect(await processAssistantJob(job, NOW)).toBe("already_handled");

    h.messages = [{ id: "m3", created_time: recent, from: { id: "ig_shop" }, message: "respuesta del dueño" }];
    expect(await processAssistantJob(job, NOW)).toBe("no_message");

    expect(h.sent).toHaveLength(0);
    expect(h.parse).not.toHaveBeenCalled();
  });
});

describe("pollAssistantInbox", () => {
  it("queues only recent, unanswered customer messages", async () => {
    h.conversations = [
      { id: "c1", messages: { data: [{ id: "new", created_time: recent, from: { id: "u2" }, message: "hola" }] } },
      { id: "c2", messages: { data: [{ id: "mine", created_time: recent, from: { id: "ig_shop" }, message: "listo" }] } },
      { id: "c3", messages: { data: [{ id: "old", created_time: new Date(NOW - 3_600_000).toISOString(), from: { id: "u3" }, message: "hola" }] } },
      { id: "c4", messages: { data: [{ id: "done", created_time: recent, from: { id: "u1" }, message: "gracias" }] } },
    ];
    h.thread = { ...h.thread!, lastProcessedMessageId: "done" };
    const result = await pollAssistantInbox(NOW);
    expect(result.enqueued).toBe(1);
    expect(h.jobs[0]).toMatchObject({ name: "assistant-reply", data: { accountConnectionId: "acc", userId: "u2" } });
  });
});
