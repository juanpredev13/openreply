import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import { getWorkerAlerts, getWorkerHealth } from "@/lib/ops/worker-health";

export const runtime = "nodejs";

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Worker alerts live in one instance-wide Redis list, so keep only the ones
  // for this workspace's own Instagram accounts. Events without a workspace,
  // the worker host and its pid stay out of tenant-facing responses.
  const ownAccounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    select: { instagramId: true },
  });
  const ownInstagramIds = new Set(ownAccounts.map((account) => account.instagramId));

  const [
    queueCounts,
    workerHealth,
    allWorkerAlerts,
    webhookFailures,
    dmFailures,
    tokenRefreshFailures,
    operationalEvents,
  ] = await Promise.all([
    getDMQueue().getJobCounts("waiting", "active", "delayed", "failed"),
    getWorkerHealth(),
    getWorkerAlerts(25),
    prisma.webhookEvent.findMany({
      where: { workspaceId, status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        object: true,
        errorMessage: true,
        createdAt: true,
        processedAt: true,
      },
    }),
    prisma.dmLog.findMany({
      where: {
        workspaceId,
        status: {
          in: [
            "FAILED",
            "SKIPPED_RATE_LIMIT",
            "SKIPPED_PLAN_LIMIT",
            "SKIPPED_NO_MATCH",
          ],
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        commentId: true,
        commentText: true,
        errorMessage: true,
        updatedAt: true,
        automation: { select: { name: true } },
      },
    }),
    prisma.operationalEvent.findMany({
      where: { workspaceId, source: "TOKEN_REFRESH", level: "ERROR" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        message: true,
        createdAt: true,
        payload: true,
      },
    }),
    prisma.operationalEvent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        source: true,
        level: true,
        message: true,
        createdAt: true,
        resolvedAt: true,
      },
    }),
  ]);

  const workerAlerts = allWorkerAlerts
    .filter(
      (alert) =>
        alert.instagramAccountId !== undefined &&
        ownInstagramIds.has(alert.instagramAccountId)
    )
    .slice(0, 10)
    .map((alert) => ({
      level: alert.level,
      message: alert.message,
      jobId: alert.jobId,
      commentId: alert.commentId,
      createdAt: alert.createdAt,
    }));

  return NextResponse.json({
    success: true,
    data: {
      queueCounts,
      workerHealth: {
        healthy: workerHealth.healthy,
        ageMs: workerHealth.ageMs,
        heartbeat: workerHealth.heartbeat
          ? { checkedAt: workerHealth.heartbeat.checkedAt }
          : null,
      },
      workerAlerts,
      webhookFailures,
      dmFailures,
      tokenRefreshFailures,
      operationalEvents,
    },
  });
}
