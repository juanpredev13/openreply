import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  userId: "user_juan" as string | null,
  memberships: [] as Array<{ workspaceId: string; userId: string; role: string; createdAt: number }>,
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "openreply_workspace" && h.cookie ? { value: h.cookie } : undefined) }),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => h.userId }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    workspaceMember: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: { userId: string; workspaceId?: string }; orderBy?: unknown }) => {
        const rows = h.memberships
          .filter((m) => m.userId === where.userId && (!where.workspaceId || m.workspaceId === where.workspaceId))
          .sort((a, b) => a.createdAt - b.createdAt);
        const row = orderBy || where.workspaceId ? rows[0] : rows[0];
        return row ? { ...row, workspace: { id: row.workspaceId, name: row.workspaceId } } : null;
      }),
    },
    workspace: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.created.push(data); return { id: "ws_new", name: data.name }; }),
    },
  },
}));

import { getWorkspaceMembership } from "../lib/workspace";
import { POST as setActive } from "../app/api/clients/active/route";
import { POST as createClient } from "../app/api/clients/route";

const req = (url: string, body: unknown) =>
  new Request(`https://app.example.test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example.test" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.test");
  h.cookie = undefined;
  h.userId = "user_juan";
  h.created = [];
  h.memberships = [
    { workspaceId: "ws_juan", userId: "user_juan", role: "OWNER", createdAt: 1 },
    { workspaceId: "ws_truebite", userId: "user_juan", role: "OWNER", createdAt: 2 },
    { workspaceId: "ws_other", userId: "user_other", role: "OWNER", createdAt: 0 },
  ];
});

describe("active client", () => {
  it("uses the oldest workspace by default and the chosen one when the user belongs to it", async () => {
    expect((await getWorkspaceMembership("user_juan"))?.workspace.id).toBe("ws_juan");
    h.cookie = "ws_truebite";
    expect((await getWorkspaceMembership("user_juan"))?.workspace.id).toBe("ws_truebite");
  });

  it("ignores a cookie that points to someone else's workspace", async () => {
    h.cookie = "ws_other";
    expect((await getWorkspaceMembership("user_juan"))?.workspace.id).toBe("ws_juan");
  });

  it("only lets the user switch to workspaces they belong to", async () => {
    const denied = await setActive(req("/api/clients/active", { workspaceId: "ws_other" }));
    expect(denied.status).toBe(404);
    expect(denied.headers.get("set-cookie")).toBeNull();

    const ok = await setActive(req("/api/clients/active", { workspaceId: "ws_truebite" }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/^openreply_workspace=ws_truebite; Path=\/; HttpOnly; SameSite=Lax/);
  });
});

describe("new client", () => {
  it("creates a workspace owned by the user with its WhatsApp and Instagram details", async () => {
    const response = await createClient(req("/api/clients", {
      name: "TrueBite", instagramHandle: "@truebite", whatsappNumber: "+506 8888 8888", whatsappAgentUrl: "", notes: "Vende por IG y WhatsApp",
    }));
    expect(response.status).toBe(201);
    expect(h.created[0]).toMatchObject({
      name: "TrueBite",
      ownerId: "user_juan",
      members: { create: { userId: "user_juan", role: "OWNER" } },
      clientProfile: { create: { instagramHandle: "truebite", whatsappNumber: "+506 8888 8888", whatsappAgentUrl: null, notes: "Vende por IG y WhatsApp" } },
    });
  });

  it("rejects an http agent link", async () => {
    const response = await createClient(req("/api/clients", { name: "X", whatsappAgentUrl: "http://insecure.test" }));
    expect(response.status).toBe(400);
  });
});
