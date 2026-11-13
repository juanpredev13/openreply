import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { apiError, ApiError, checkOrigin, readJson } from "@/lib/integrations/http";

const configSchema = z
  .object({
    enabled: z.boolean(),
    businessInfo: z.string().max(20_000),
    handoffMessage: z.string().max(500),
    whatsappUrl: z
      .union([
        z.literal(""),
        z.string().url().max(500).refine((u) => u.startsWith("https://"), "must be https"),
      ])
      .optional(),
  })
  .strict();

async function adminContext() {
  const context = await getCurrentWorkspaceContext();
  if (!context) throw new ApiError("Unauthorized", 401);
  if (!canManageWorkspace(context.role)) throw new ApiError("Admin role required", 403);
  return context;
}

export async function GET() {
  try {
    const context = await adminContext();
    const [config, pausedThreads] = await Promise.all([
      prisma.assistantConfig.findUnique({ where: { workspaceId: context.workspaceId } }),
      prisma.assistantThread.findMany({
        where: { workspaceId: context.workspaceId, paused: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { id: true, username: true, userId: true, pausedReason: true, updatedAt: true },
      }),
    ]);
    return Response.json(
      {
        config: config ?? { enabled: false, businessInfo: "", handoffMessage: "", whatsappUrl: "" },
        pausedThreads,
        apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    checkOrigin(request);
    const context = await adminContext();
    const input = configSchema.safeParse(await readJson(request));
    if (!input.success) throw new ApiError(`Invalid assistant settings: ${input.error.issues[0]?.path.join(".") ?? ""}`);
    const data = { ...input.data, whatsappUrl: input.data.whatsappUrl || null };
    const config = await prisma.assistantConfig.upsert({
      where: { workspaceId: context.workspaceId },
      create: { workspaceId: context.workspaceId, ...data },
      update: data,
    });
    return Response.json({ config });
  } catch (error) {
    return apiError(error);
  }
}

/** Resume the assistant in a conversation it handed off or an admin paused. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const context = await adminContext();
    const input = z
      .object({ threadId: z.string().min(1).max(100), paused: z.boolean() })
      .strict()
      .safeParse(await readJson(request));
    if (!input.success) throw new ApiError("threadId and paused required");
    const updated = await prisma.assistantThread.updateMany({
      where: { id: input.data.threadId, workspaceId: context.workspaceId },
      data: { paused: input.data.paused, pausedReason: input.data.paused ? "admin" : null },
    });
    if (!updated.count) throw new ApiError("Conversation not found", 404);
    return Response.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}
