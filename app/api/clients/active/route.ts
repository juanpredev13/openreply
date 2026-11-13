import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUserId } from "@/lib/auth";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspace";
import { apiError, ApiError, checkOrigin, readJson } from "@/lib/integrations/http";

/** Switch the active client. Only workspaces the user belongs to are accepted. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const userId = await getCurrentUserId();
    if (!userId) throw new ApiError("Unauthorized", 401);
    const input = z.object({ workspaceId: z.string().min(1).max(100) }).strict().safeParse(await readJson(request));
    if (!input.success) throw new ApiError("workspaceId required");
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId, workspaceId: input.data.workspaceId },
      select: { workspaceId: true },
    });
    if (!membership) throw new ApiError("Workspace not found", 404);
    const response = Response.json({ activeWorkspaceId: membership.workspaceId });
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    response.headers.append(
      "Set-Cookie",
      `${ACTIVE_WORKSPACE_COOKIE}=${encodeURIComponent(membership.workspaceId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`
    );
    return response;
  } catch (error) {
    return apiError(error);
  }
}
