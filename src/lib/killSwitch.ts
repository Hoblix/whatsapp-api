/**
 * Kill Switch — auto-disable workflows with high failure rates.
 *
 * Evaluates the last WINDOW_SIZE executions for a workflow.
 * If >FAILURE_THRESHOLD of them are "failed", the workflow is paused
 * with a human-readable reason. Runs asynchronously via waitUntil().
 */

import { eq, and, desc } from "drizzle-orm";
import type { Database } from "./db";
import {
  automationWorkflowsTable,
  automationExecutionsTable,
} from "./schema";

// ── Constants ─────────────────────────────────────────────────────────────────

export const WINDOW_SIZE = 10;
export const FAILURE_THRESHOLD = 0.5;
export const KILL_SWITCH_MESSAGE =
  "This workflow was paused because recent runs had issues. Review your rules and re-enable.";

// ── Core ──────────────────────────────────────────────────────────────────────

export async function evaluateKillSwitch(
  db: Database,
  workflowId: number,
): Promise<void> {
  // 1. Query last WINDOW_SIZE executions ordered by startedAt DESC
  const recent = await db
    .select()
    .from(automationExecutionsTable)
    .where(eq(automationExecutionsTable.workflowId, workflowId))
    .orderBy(desc(automationExecutionsTable.startedAt))
    .limit(WINDOW_SIZE);

  // 2. Not enough data — skip
  if (recent.length < WINDOW_SIZE) return;

  // 3. Count failures
  const failedCount = recent.filter((r) => r.status === "failed").length;

  // 4. Check threshold (strictly greater than)
  if (failedCount / WINDOW_SIZE > FAILURE_THRESHOLD) {
    console.warn(
      `[kill-switch] Tripping kill switch for workflow ${workflowId}: ${failedCount}/${WINDOW_SIZE} recent executions failed`,
    );

    // 5. Disable workflow — AND is_active = true for idempotency
    await db
      .update(automationWorkflowsTable)
      .set({
        isActive: false,
        disabledReason: "kill_switch",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(automationWorkflowsTable.id, workflowId),
          eq(automationWorkflowsTable.isActive, true),
        ),
      );
  }
}
