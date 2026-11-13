"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";

type Profile = { instagramHandle: string | null; whatsappNumber: string | null; whatsappAgentUrl: string | null; notes: string };
type Client = {
  id: string;
  name: string;
  role: string;
  profile: Profile | null;
  instagramAccounts: { username: string; provider: string }[];
  assistantEnabled: boolean;
  activeCampaigns: number;
};
type Form = { name: string; instagramHandle: string; whatsappNumber: string; whatsappAgentUrl: string; notes: string };

const emptyForm: Form = { name: "", instagramHandle: "", whatsappNumber: "", whatsappAgentUrl: "", notes: "" };

function waLink(number: string) {
  return `https://wa.me/${number.replace(/\D/g, "")}`;
}

export default function ClientsPage() {
  const { t } = useI18n();
  const [clients, setClients] = useState<Client[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [editing, setEditing] = useState<Form | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/clients");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setClients(data.clients);
    setActiveId(data.activeWorkspaceId);
  }

  useEffect(() => { void Promise.resolve().then(load).catch((e) => setNotice(e.message)); }, []);

  async function call(url: string, method: string, body: unknown) {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  }

  async function run(action: () => Promise<void>) {
    setBusy(true); setNotice("");
    try { await action(); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }

  const create = () => run(async () => {
    const data = await call("/api/clients", "POST", form);
    setForm(emptyForm);
    await call("/api/clients/active", "POST", { workspaceId: data.client.id });
    window.location.reload();
  });

  const switchTo = (client: Client) => run(async () => {
    await call("/api/clients/active", "POST", { workspaceId: client.id });
    window.location.reload();
  });

  const saveActive = () => run(async () => {
    if (!editing) return;
    await call("/api/clients", "PATCH", editing);
    setEditing(null);
    await load();
    setNotice(t("Saved."));
  });

  const active = clients.find((c) => c.id === activeId);

  return <div className="mx-auto max-w-5xl space-y-6 p-6">
    <h1 className="text-2xl font-semibold">{t("Clients")}</h1>
    <p className="text-muted">{t("Each client has its own workspace: Instagram account, campaigns, AI assistant and team. Switch client to manage it; the whole dashboard follows the active client.")}</p>
    {notice && <p role="status">{notice}</p>}

    <div className="grid gap-4 md:grid-cols-2">
      {clients.map((client) => {
        const isActive = client.id === activeId;
        return <section key={client.id} className={`space-y-2 rounded border p-4 ${isActive ? "border-accent" : "border-border"}`}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="truncate text-lg font-semibold">{client.name}</h2>
            {isActive
              ? <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{t("Active")}</span>
              : <button disabled={busy} onClick={() => switchTo(client)} className="rounded border border-border px-3 py-1 text-sm">{t("Manage")}</button>}
          </div>
          <p className="text-sm">
            <span className="text-muted">Instagram: </span>
            {client.instagramAccounts.length
              ? client.instagramAccounts.map((a) => `@${a.username}`).join(", ")
              : <span className="text-warning">{client.profile?.instagramHandle ? `@${client.profile.instagramHandle} · ` : ""}{t("not connected")}</span>}
          </p>
          <p className="text-sm">
            <span className="text-muted">WhatsApp: </span>
            {client.profile?.whatsappNumber
              ? <a className="underline" href={waLink(client.profile.whatsappNumber)} target="_blank" rel="noopener noreferrer">{client.profile.whatsappNumber}</a>
              : t("not set")}
            {client.profile?.whatsappAgentUrl && <> · <a className="underline" href={client.profile.whatsappAgentUrl} target="_blank" rel="noopener noreferrer">{t("WhatsApp agent")}</a></>}
          </p>
          <p className="text-sm text-muted">
            {t("{count} active campaigns", { count: client.activeCampaigns })} · {client.assistantEnabled ? t("AI assistant on") : t("AI assistant off")}
          </p>
          {client.profile?.notes && <p className="whitespace-pre-wrap text-sm">{client.profile.notes}</p>}
        </section>;
      })}
    </div>

    {active && (active.role === "OWNER" || active.role === "ADMIN") && <section className="space-y-3 rounded border border-border p-4">
      <h2 className="text-lg font-semibold">{t("Active client details")}: {active.name}</h2>
      {editing ? <ClientFields form={editing} setForm={setEditing} busy={busy} t={t} /> : null}
      {editing
        ? <div className="flex gap-2">
            <button disabled={busy} onClick={saveActive} className="rounded bg-accent px-4 py-2 text-white disabled:opacity-50">{t("Save")}</button>
            <button disabled={busy} onClick={() => setEditing(null)} className="rounded border border-border px-4 py-2">{t("Cancel")}</button>
          </div>
        : <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => setEditing({
              name: active.name,
              instagramHandle: active.profile?.instagramHandle ?? "",
              whatsappNumber: active.profile?.whatsappNumber ?? "",
              whatsappAgentUrl: active.profile?.whatsappAgentUrl ?? "",
              notes: active.profile?.notes ?? "",
            })} className="rounded border border-border px-4 py-2">{t("Edit details")}</button>
            <a href="/api/instagram/connect" className="rounded bg-accent px-4 py-2 text-white">{t("Connect this client's Instagram")}</a>
          </div>}
      <p className="text-sm text-muted">{t("To connect a client's Instagram, the client must first give you admin access to their Facebook Page and Instagram account in Meta Business Suite. In the Facebook dialog, select only this client's Page.")}</p>
    </section>}

    <section className="space-y-3 rounded border border-border p-4">
      <h2 className="text-lg font-semibold">{t("New client")}</h2>
      <ClientFields form={form} setForm={(f) => setForm(f ?? emptyForm)} busy={busy} t={t} />
      <button disabled={busy || !form.name.trim()} onClick={create} className="rounded bg-accent px-4 py-2 text-white disabled:opacity-50">{t("Create client")}</button>
    </section>
  </div>;
}

function ClientFields({ form, setForm, busy, t }: {
  form: Form;
  setForm: (form: Form | null) => void;
  busy: boolean;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const field = (key: keyof Form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    <label className="block">{label}
      <input disabled={busy} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="mt-1 w-full rounded border border-border p-2" {...props} />
    </label>;
  return <div className="grid gap-3 md:grid-cols-2">
    {field("name", t("Client name"), { maxLength: 100, placeholder: "TrueBite" })}
    {field("instagramHandle", "Instagram", { maxLength: 60, placeholder: "@truebite" })}
    {field("whatsappNumber", t("WhatsApp number"), { maxLength: 30, placeholder: "+506 8888 8888" })}
    {field("whatsappAgentUrl", t("WhatsApp agent link (optional)"), { type: "url", maxLength: 500, placeholder: "https://..." })}
    <label className="block md:col-span-2">{t("Notes")}
      <textarea rows={3} maxLength={5000} disabled={busy} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
        className="mt-1 w-full rounded border border-border p-2" />
    </label>
  </div>;
}
