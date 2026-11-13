import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUserId } from "@/lib/auth";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { apiError, ApiError, checkOrigin, readJson } from "@/lib/integrations/http";

const optionalText = (max: number) => z.string().trim().max(max).optional();
const profileSchema = z
  .object({
    instagramHandle: optionalText(60),
    whatsappNumber: z.string().trim().max(30).regex(/^[+\d\s-]*$/, "digits only").optional(),
    whatsappAgentUrl: z
      .union([z.literal(""), z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "must be https")])
      .optional(),
    notes: optionalText(5000),
  })
  .strict();

function profileData(input: z.infer<typeof profileSchema>) {
  return {
    instagramHandle: input.instagramHandle?.replace(/^@/, "") || null,
    whatsappNumber: input.whatsappNumber || null,
    whatsappAgentUrl: input.whatsappAgentUrl || null,
    notes: input.notes ?? "",
  };
}

/** Every workspace the user belongs to, with its client details. */
export async function GET() {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new ApiError("Unauthorized", 401);
    const active = await getCurrentWorkspaceContext();
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: {
        role: true,
        workspace: {
          select: {
            id: true,
            name: true,
            clientProfile: true,
            instagramAccounts: { select: { username: true, provider: true } },
            assistantConfig: { select: { enabled: true } },
            _count: { select: { automations: { where: { isActive: true } } } },
          },
        },
      },
    });
    return Response.json(
      {
        activeWorkspaceId: active?.workspaceId ?? null,
        clients: memberships.map(({ role, workspace }) => ({
          id: workspace.id,
          name: workspace.name,
          role,
          profile: workspace.clientProfile,
          instagramAccounts: workspace.instagramAccounts,
          assistantEnabled: workspace.assistantConfig?.enabled ?? false,
          activeCampaigns: workspace._count.automations,
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return apiError(error);
  }
}

/** Create a client: a new workspace owned by the current user. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const userId = await getCurrentUserId();
    if (!userId) throw new ApiError("Unauthorized", 401);
    const input = profileSchema.extend({ name: z.string().trim().min(1).max(100) }).strict().safeParse(await readJson(request));
    if (!input.success) throw new ApiError(`Invalid client: ${input.error.issues[0]?.path.join(".") ?? ""}`);
    const { name, ...profile } = input.data;
    const workspace = await prisma.workspace.create({
      data: {
        name,
        ownerId: userId,
        members: { create: { userId, role: "OWNER" } },
        clientProfile: { create: profileData(profile) },
      },
      select: { id: true, name: true },
    });
    return Response.json({ client: workspace }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

/** Update the details of the active client (admins only). */
export async function PATCH(request: Request) {
  try {
    checkOrigin(request);
    const context = await getCurrentWorkspaceContext();
    if (!context) throw new ApiError("Unauthorized", 401);
    if (!canManageWorkspace(context.role)) throw new ApiError("Admin role required", 403);
    const input = profileSchema.extend({ name: z.string().trim().min(1).max(100).optional() }).strict().safeParse(await readJson(request));
    if (!input.success) throw new ApiError(`Invalid client: ${input.error.issues[0]?.path.join(".") ?? ""}`);
    const { name, ...profile } = input.data;
    if (name) await prisma.workspace.update({ where: { id: context.workspaceId }, data: { name } });
    const saved = await prisma.clientProfile.upsert({
      where: { workspaceId: context.workspaceId },
      create: { workspaceId: context.workspaceId, ...profileData(profile) },
      update: profileData(profile),
    });
    return Response.json({ profile: saved });
  } catch (error) {
    return apiError(error);
  }
}
