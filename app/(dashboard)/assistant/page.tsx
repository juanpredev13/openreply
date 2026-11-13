"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";

type Config = { enabled: boolean; businessInfo: string; handoffMessage: string; whatsappUrl: string | null };
type PausedThread = { id: string; username: string | null; userId: string; pausedReason: string | null; updatedAt: string };

const EXAMPLE = `Products and prices:
- Snail cream 50 ml: ₡12 500
- Sunscreen SPF 50: ₡9 900

Shipping: Correos de Costa Rica, ₡2 500, 2–4 business days.
Payment: SINPE Móvil.
Hours: Monday to Saturday, 9 am – 6 pm.
Returns: within 7 days, unopened products.`;

export default function AssistantPage() {
  const { t } = useI18n();
  const [config, setConfig] = useState<Config>({ enabled: false, businessInfo: "", handoffMessage: "", whatsappUrl: "" });
  const [threads, setThreads] = useState<PausedThread[]>([]);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/assistant");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setConfig({ ...data.config, whatsappUrl: data.config.whatsappUrl ?? "" });
    setThreads(data.pausedThreads);
    setApiKeyConfigured(data.apiKeyConfigured);
  }

  useEffect(() => { void Promise.resolve().then(load).catch((e) => setNotice(e.message)); }, []);

  async function save() {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/assistant", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, whatsappUrl: config.whatsappUrl ?? "" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setNotice(t("Saved."));
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  async function resume(thread: PausedThread) {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: thread.id, paused: false }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      await load();
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-4xl space-y-6 p-6">
    <h1 className="text-2xl font-semibold">{t("AI assistant")}</h1>
    <p className="text-muted">{t("Answers Instagram DMs with the information you write below. When someone wants to buy, pay or talk to a person, it sends them to WhatsApp and stops answering that conversation.")}</p>
    {!apiKeyConfigured && <p role="alert" className="rounded border border-warning p-3 text-warning">{t("ANTHROPIC_API_KEY is not set on the server, so the assistant cannot reply yet.")}</p>}
    {notice && <p role="status">{notice}</p>}

    <section className="space-y-4 rounded border border-border p-4">
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" disabled={busy} checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} />
        {t("Answer DMs automatically")}
      </label>
      <label className="block">
        <span className="font-medium">{t("Business information")}</span>
        <span className="block text-sm text-muted">{t("Products, prices, shipping, payment, hours and returns. The assistant never answers beyond this.")}</span>
        <textarea rows={14} maxLength={20000} disabled={busy} placeholder={EXAMPLE} value={config.businessInfo}
          onChange={(e) => setConfig({ ...config, businessInfo: e.target.value })}
          className="mt-2 w-full rounded border border-border p-2 font-mono text-sm" />
      </label>
      <label className="block">
        <span className="font-medium">{t("WhatsApp link for handoff")}</span>
        <input type="url" maxLength={500} disabled={busy} placeholder="https://wa.me/50688888888" value={config.whatsappUrl ?? ""}
          onChange={(e) => setConfig({ ...config, whatsappUrl: e.target.value })}
          className="mt-2 w-full rounded border border-border p-2" />
      </label>
      <label className="block">
        <span className="font-medium">{t("Handoff message")}</span>
        <input maxLength={500} disabled={busy} placeholder={t("Escríbenos por WhatsApp y te ayudamos con tu pedido.")} value={config.handoffMessage}
          onChange={(e) => setConfig({ ...config, handoffMessage: e.target.value })}
          className="mt-2 w-full rounded border border-border p-2" />
      </label>
      <button disabled={busy} onClick={save} className="rounded bg-accent px-4 py-2 text-white disabled:opacity-50">{t("Save")}</button>
    </section>

    <section className="space-y-3 rounded border border-border p-4">
      <h2 className="text-lg font-semibold">{t("Paused conversations")}</h2>
      <p className="text-sm text-muted">{t("The assistant stays silent here after a handoff. Resume it once the person has been helped.")}</p>
      {threads.length === 0 ? <p className="text-sm text-muted">{t("None.")}</p> : <ul className="divide-y divide-border">
        {threads.map((thread) => <li key={thread.id} className="flex items-center justify-between py-2">
          <span>@{thread.username ?? thread.userId} <span className="text-sm text-muted">· {thread.pausedReason === "handoff" ? t("sent to WhatsApp") : t("paused")}</span></span>
          <button disabled={busy} onClick={() => resume(thread)} className="rounded border border-border px-3 py-1 text-sm">{t("Resume")}</button>
        </li>)}
      </ul>}
    </section>
  </div>;
}
