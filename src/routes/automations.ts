/**
 * Automation Workflows routes — Hono / Cloudflare Workers
 *
 * GET    /automations              — list all workflows
 * POST   /automations              — create workflow + root trigger node
 * GET    /automations/:id          — get workflow with node tree
 * PATCH  /automations/:id          — update workflow
 * DELETE /automations/:id          — delete workflow (cascade)
 * PUT    /automations/:id/nodes    — full-replace node tree
 * POST   /automations/:id/toggle   — activate / deactivate
 */

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq, and, gt, desc, inArray } from "drizzle-orm";
import type { HonoEnv } from "../env";
import { createDb, getDbUrl } from "../lib/db";
import {
  automationWorkflowsTable,
  automationNodesTable,
  automationExecutionsTable,
  automationConditionLogsTable,
  authSessionsTable,
  allowedUsersTable,
  conversationsTable,
  messagesTable,
} from "../lib/schema";
import type { AutomationNode } from "../lib/schema";
import { fireAutomationWorkflows } from "./automationEngine";

const app = new Hono<HonoEnv>();

// ── Super-admin middleware ────────────────────────────────────────────────────

app.use("/automations/*", async (c, next) => {
  const db = createDb(getDbUrl(c.env));
  const token = getCookie(c, "auth_token");
  if (!token) return c.json({ error: "Not authenticated" }, 401);

  const [session] = await db
    .select()
    .from(authSessionsTable)
    .where(and(eq(authSessionsTable.token, token), gt(authSessionsTable.expiresAt, new Date())))
    .limit(1);
  if (!session) return c.json({ error: "Session expired" }, 401);

  const [user] = await db
    .select()
    .from(allowedUsersTable)
    .where(eq(allowedUsersTable.phoneNumber, session.phoneNumber))
    .limit(1);
  if (!user || user.role !== "super_admin") return c.json({ error: "Super admin required" }, 403);

  c.set("adminPhone", session.phoneNumber);
  await next();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildTree(nodes: AutomationNode[]): any {
  const map = new Map<number, any>();
  const roots: any[] = [];

  for (const node of nodes) {
    map.set(node.id, { ...node, children: [] });
  }
  for (const node of nodes) {
    const item = map.get(node.id)!;
    if (node.parentNodeId && map.has(node.parentNodeId)) {
      map.get(node.parentNodeId)!.children.push(item);
    } else {
      roots.push(item);
    }
  }
  // Sort children by position
  for (const [, item] of map) {
    item.children.sort((a: any, b: any) => a.position - b.position);
  }
  return roots[0] ?? null; // root trigger node
}

// ── List all workflows ──────────────────────────────────────────────────────

app.get("/automations", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const workflows = await db
    .select()
    .from(automationWorkflowsTable)
    .orderBy(desc(automationWorkflowsTable.updatedAt));
  return c.json(workflows);
});

// ── Create workflow ─────────────────────────────────────────────────────────

app.post("/automations", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const body = await c.req.json<{
    name: string;
    description?: string;
    triggerType: string;
    triggerConfig?: Record<string, unknown>;
  }>();

  if (!body.name || !body.triggerType) {
    return c.json({ error: "name and triggerType are required" }, 400);
  }

  const [workflow] = await db
    .insert(automationWorkflowsTable)
    .values({
      name: body.name,
      description: body.description ?? null,
      triggerType: body.triggerType,
      triggerConfig: body.triggerConfig ?? {},
    })
    .returning();

  // Auto-create root trigger node
  const [triggerNode] = await db
    .insert(automationNodesTable)
    .values({
      workflowId: workflow.id,
      parentNodeId: null,
      nodeType: "trigger",
      position: 0,
      config: body.triggerConfig ?? {},
    })
    .returning();

  return c.json({ workflow, triggerNode }, 201);
});

// ── Get workflow + node tree ────────────────────────────────────────────────

app.get("/automations/:id", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const [workflow] = await db
    .select()
    .from(automationWorkflowsTable)
    .where(eq(automationWorkflowsTable.id, id))
    .limit(1);
  if (!workflow) return c.json({ error: "Workflow not found" }, 404);

  const nodes = await db
    .select()
    .from(automationNodesTable)
    .where(eq(automationNodesTable.workflowId, id));

  const tree = buildTree(nodes);

  return c.json({ workflow, tree, nodes });
});

// ── Update workflow ─────────────────────────────────────────────────────────

app.patch("/automations/:id", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const body = await c.req.json<{
    name?: string;
    description?: string;
    triggerType?: string;
    triggerConfig?: Record<string, unknown>;
    isActive?: boolean;
    debugMode?: boolean;
  }>();

  const updates: Partial<typeof automationWorkflowsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.triggerType !== undefined) updates.triggerType = body.triggerType;
  if (body.triggerConfig !== undefined) updates.triggerConfig = body.triggerConfig;
  if (body.debugMode !== undefined) updates.debugMode = body.debugMode;
  if (body.isActive !== undefined) {
    updates.isActive = body.isActive;
    if (body.isActive) {
      updates.disabledReason = null;
    }
  }

  const [workflow] = await db
    .update(automationWorkflowsTable)
    .set(updates)
    .where(eq(automationWorkflowsTable.id, id))
    .returning();

  if (!workflow) return c.json({ error: "Workflow not found" }, 404);

  // Update root trigger node config if triggerConfig changed
  if (body.triggerConfig !== undefined) {
    const [rootNode] = await db
      .select()
      .from(automationNodesTable)
      .where(
        and(
          eq(automationNodesTable.workflowId, id),
          eq(automationNodesTable.nodeType, "trigger"),
        ),
      )
      .limit(1);

    if (rootNode) {
      await db
        .update(automationNodesTable)
        .set({ config: body.triggerConfig })
        .where(eq(automationNodesTable.id, rootNode.id));
    }
  }

  return c.json(workflow);
});

// ── Delete workflow ─────────────────────────────────────────────────────────

app.delete("/automations/:id", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  await db.delete(automationWorkflowsTable).where(eq(automationWorkflowsTable.id, id));
  return c.json({ ok: true });
});

// ── Full-replace node tree ──────────────────────────────────────────────────

app.put("/automations/:id/nodes", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  // Verify workflow exists
  const [workflow] = await db
    .select()
    .from(automationWorkflowsTable)
    .where(eq(automationWorkflowsTable.id, id))
    .limit(1);
  if (!workflow) return c.json({ error: "Workflow not found" }, 404);

  const body = await c.req.json<{
    nodes: Array<{
      tempId: string;
      parentTempId: string | null;
      nodeType: string;
      position: number;
      config: Record<string, unknown>;
    }>;
  }>();

  if (!body.nodes || !Array.isArray(body.nodes)) {
    return c.json({ error: "nodes array is required" }, 400);
  }

  // Delete all existing nodes for this workflow
  await db.delete(automationNodesTable).where(eq(automationNodesTable.workflowId, id));

  // Insert nodes in order, building tempId → realId map
  const tempIdToRealId = new Map<string, number>();
  const insertedNodes: any[] = [];

  // Sort so parents come before children (nodes with null parentTempId first)
  const sorted = [...body.nodes].sort((a, b) => {
    if (a.parentTempId === null && b.parentTempId !== null) return -1;
    if (a.parentTempId !== null && b.parentTempId === null) return 1;
    return 0;
  });

  for (const node of sorted) {
    const parentNodeId = node.parentTempId ? (tempIdToRealId.get(node.parentTempId) ?? null) : null;

    const [inserted] = await db
      .insert(automationNodesTable)
      .values({
        workflowId: id,
        parentNodeId,
        nodeType: node.nodeType,
        position: node.position,
        config: node.config,
      })
      .returning();

    tempIdToRealId.set(node.tempId, inserted.id);
    insertedNodes.push(inserted);
  }

  return c.json({ nodes: insertedNodes });
});

// ── Toggle active/inactive ──────────────────────────────────────────────────

app.post("/automations/:id/toggle", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const [workflow] = await db
    .select()
    .from(automationWorkflowsTable)
    .where(eq(automationWorkflowsTable.id, id))
    .limit(1);
  if (!workflow) return c.json({ error: "Workflow not found" }, 404);

  const [updated] = await db
    .update(automationWorkflowsTable)
    .set({
      isActive: !workflow.isActive,
      updatedAt: new Date(),
      ...(!workflow.isActive ? { disabledReason: null } : {}),
    })
    .where(eq(automationWorkflowsTable.id, id))
    .returning();

  return c.json(updated);
});

// ── Test trigger (simulate ad click for a phone number) ────────────────────

app.post("/automations/:id/test-trigger", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  const body = await c.req.json<{ phoneNumber?: string }>();
  const phone = (body.phoneNumber ?? "").replace(/\D/g, "");
  if (!phone) return c.json({ error: "phoneNumber required" }, 400);

  // Find or create conversation
  let conversation = await db.query.conversationsTable.findFirst({
    where: eq(conversationsTable.phoneNumber, phone),
  });
  if (!conversation) {
    const [row] = await db.insert(conversationsTable).values({
      phoneNumber: phone,
      lastMessageAt: new Date(),
    }).returning();
    conversation = row;
  }

  // Simulate trigger message matching the workflow's trigger config
  const [workflow] = await db
    .select()
    .from(automationWorkflowsTable)
    .where(eq(automationWorkflowsTable.id, id))
    .limit(1);
  if (!workflow) return c.json({ error: "Workflow not found" }, 404);

  const triggerConfig = workflow.triggerConfig as Record<string, unknown>;
  const messageBody = (triggerConfig.exactText as string)
    ?? (triggerConfig.prefilledText as string)
    ?? "/test_trigger";

  const fakeMessage = {
    id: `wamid.TEST_${Date.now()}`,
    from: phone,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: "text",
    text: { body: messageBody },
  };

  // Fire ONLY this specific workflow, not all
  await fireAutomationWorkflows(db, phone, conversation!.id, fakeMessage, null, c.env, c.executionCtx);

  return c.json({ ok: true, message: `Test trigger fired for workflow ${id}, phone ${phone}` });
});

// ── Get execution runs with condition logs ─────────────────────────────────

app.get("/automations/:id/runs", async (c) => {
  const db = createDb(getDbUrl(c.env));
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

  // Fetch last 20 executions for this workflow
  const executions = await db
    .select()
    .from(automationExecutionsTable)
    .where(eq(automationExecutionsTable.workflowId, id))
    .orderBy(desc(automationExecutionsTable.startedAt))
    .limit(20);

  if (executions.length === 0) {
    return c.json([]);
  }

  // Collect execution IDs and fetch their condition logs
  const executionIds = executions.map((e) => e.id);
  const logs = await db
    .select()
    .from(automationConditionLogsTable)
    .where(inArray(automationConditionLogsTable.executionId, executionIds));

  // Group logs by executionId
  const logsByExecution = new Map<number, typeof logs>();
  for (const log of logs) {
    const existing = logsByExecution.get(log.executionId) ?? [];
    existing.push(log);
    logsByExecution.set(log.executionId, existing);
  }

  // Load workflow nodes for step tracking
  const nodes = await db
    .select()
    .from(automationNodesTable)
    .where(eq(automationNodesTable.workflowId, id));

  // Get message delivery stats for template actions
  // Query outbound messages linked to this workflow's conversations
  const executionConvIds = [...new Set(executions.map(e => e.conversationId).filter(Boolean))];
  let messageStats: Record<string, { sent: number; delivered: number; read: number; failed: number }> = {};
  if (executionConvIds.length > 0) {
    const outboundMsgs = await db
      .select({
        body: messagesTable.body,
        status: messagesTable.status,
      })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.direction, "outbound"),
          inArray(messagesTable.conversationId, executionConvIds as number[]),
        )
      );

    // Group by template name, count statuses
    for (const msg of outboundMsgs) {
      // Extract template name from "[Template: xyz]"
      const match = msg.body?.match(/\[Template: (.+?)\]/);
      const key = match?.[1] ?? msg.body ?? "unknown";
      if (!messageStats[key]) messageStats[key] = { sent: 0, delivered: 0, read: 0, failed: 0 };
      const s = (msg.status ?? "sent") as string;
      if (s === "sent") messageStats[key].sent++;
      else if (s === "delivered") messageStats[key].delivered++;
      else if (s === "read") messageStats[key].read++;
      else if (s === "failed") messageStats[key].failed++;
    }
  }

  const nodeList = nodes.map(n => ({
    id: n.id,
    nodeType: n.nodeType,
    parentNodeId: n.parentNodeId,
    position: n.position,
    config: n.config,
  }));

  // Attach condition logs + compute step statuses for each execution
  const result = executions.map((exec) => {
    // Determine which node the execution reached
    const currentNodeId = exec.currentNodeId;
    const status = exec.status; // running, waiting, completed, failed

    // Build step statuses: completed up to currentNode, waiting at currentNode, pending after
    const stepStatuses: Record<number, "completed" | "waiting" | "pending" | "skipped"> = {};
    let reachedCurrent = false;

    // Walk nodes in tree order to mark statuses
    const rootNode = nodes.find(n => !n.parentNodeId);
    if (rootNode) {
      const queue = [rootNode];
      const visited = new Set<number>();
      while (queue.length > 0) {
        const node = queue.shift()!;
        if (visited.has(node.id)) continue;
        visited.add(node.id);

        if (status === "completed") {
          stepStatuses[node.id] = "completed";
        } else if (node.id === currentNodeId) {
          stepStatuses[node.id] = "waiting";
          reachedCurrent = true;
        } else if (!reachedCurrent) {
          stepStatuses[node.id] = "completed";
        } else {
          stepStatuses[node.id] = "pending";
        }

        // Add children
        const children = nodes.filter(n => n.parentNodeId === node.id).sort((a, b) => a.position - b.position);
        queue.push(...children);
      }
    }

    return {
      ...exec,
      conditionLogs: logsByExecution.get(exec.id) ?? [],
      stepStatuses,
    };
  });

  return c.json({ runs: result, nodes: nodeList, messageStats });
});

export default app;
