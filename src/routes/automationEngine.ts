/**
 * Automation Workflow Execution Engine
 *
 * Fired from the webhook handler to evaluate and execute automation workflows
 * when inbound messages arrive.
 */

import { eq, and, desc, gt } from "drizzle-orm";
import type { Database } from "../lib/db";
import {
  automationWorkflowsTable,
  automationNodesTable,
  automationExecutionsTable,
  conversationsTable,
  flowSubmissionsTable,
  messagesTable,
} from "../lib/schema";
import type { AutomationNode } from "../lib/schema";
import { callWhatsAppAPI } from "./sendHelpers";
import { evaluateKillSwitch } from "../lib/killSwitch";
import { evaluateSingleCondition } from "../lib/conditionEngineV2";
import { getSchemaByFlowIdAndVersion } from "../lib/schemaAccessors";
import { mapWebhookPayload } from "../lib/webhookMapper";
import type { ConditionV2Config, ConditionResult, FailedReason } from "../lib/conditionEngineV2.types";
import { FAILED_MESSAGES } from "../lib/conditionEngineV2.types";
import { buildDecisionEntry, shouldLog, flushDecisionLog } from "../lib/decisionLogger";
import type { DecisionEntry, DecisionRecord } from "../lib/decisionLogger";

// ── Public entry point ──────────────────────────────────────────────────────

export async function fireAutomationWorkflows(
  db: Database,
  phone: string,
  conversationId: number,
  message: any,
  referral: Record<string, unknown> | null,
  env: any,
  executionCtx?: { waitUntil(promise: Promise<any>): void },
  isNewConversation?: boolean,
): Promise<void> {
  // 1. Query active workflows
  console.log(`[automation] Querying active workflows...`);
  let workflows;
  try {
    workflows = await db
      .select()
      .from(automationWorkflowsTable)
      .where(eq(automationWorkflowsTable.isActive, true));
  } catch (err: any) {
    console.error(`[automation] FAILED to query workflows:`, err.message);
    return;
  }
  console.log(`[automation] Found ${workflows.length} active workflows`);

  if (workflows.length === 0) return;

  for (const workflow of workflows) {
    // 2. Match trigger
    const matched = matchTrigger(workflow.triggerType, workflow.triggerConfig as Record<string, unknown>, referral, message, isNewConversation);
    console.log(`[automation] Trigger check: workflow="${workflow.name}" type=${workflow.triggerType} matched=${matched} referral=${!!referral} msgBody="${(message?.text?.body ?? "").substring(0, 30)}"`);
    if (!matched) continue;

    console.log(`[automation] Matched workflow "${workflow.name}" (id=${workflow.id}) for phone=${phone}`);

    try {
      // 3. Create execution row
      const [execution] = await db
        .insert(automationExecutionsTable)
        .values({
          workflowId: workflow.id,
          phoneNumber: phone,
          conversationId,
          status: "running",
          context: {
            phone,
            conversationId,
            message,
            referral,
          },
        })
        .returning();

      // 4. Load all nodes for this workflow
      const nodes = await db
        .select()
        .from(automationNodesTable)
        .where(eq(automationNodesTable.workflowId, workflow.id));

      // Find root trigger node
      const triggerNode = nodes.find((n) => n.nodeType === "trigger" && n.parentNodeId === null);
      if (!triggerNode) {
        console.warn(`[automation] No trigger node found for workflow ${workflow.id}`);
        await markExecution(db, execution.id, "failed");
        if (executionCtx) {
          executionCtx.waitUntil(
            evaluateKillSwitch(db, workflow.id).catch((err) =>
              console.error(`[kill-switch] Error evaluating workflow ${workflow.id}:`, err)
            )
          );
        }
        continue;
      }

      // Build parent→children map
      const childrenMap = buildChildrenMap(nodes);

      // Walk the tree starting from trigger node's children
      const triggerChildren = childrenMap.get(triggerNode.id) ?? [];
      const ctx: ExecutionContext = {
        db,
        phone,
        conversationId,
        message,
        referral,
        env,
        executionId: execution.id,
        workflowId: workflow.id,
        debugMode: (workflow as any).debugMode ?? false,
        executionCtx,
        nodes,
        childrenMap,
      };

      let completed = true;
      for (const child of triggerChildren) {
        const result = await walkNode(ctx, child);
        if (result === "waiting") {
          completed = false;
          break;
        }
      }

      // 5. Mark execution completed or leave as waiting
      if (completed) {
        await markExecution(db, execution.id, "completed");
        if (executionCtx) {
          executionCtx.waitUntil(
            evaluateKillSwitch(db, workflow.id).catch((err) =>
              console.error(`[kill-switch] Error evaluating workflow ${workflow.id}:`, err)
            )
          );
        }
      }
    } catch (err) {
      console.error(`[automation] Error executing workflow "${workflow.name}":`, err);
    }
  }
}

// ── Trigger matching ────────────────────────────────────────────────────────

function matchTrigger(
  triggerType: string,
  triggerConfig: Record<string, unknown>,
  referral: Record<string, unknown> | null,
  message?: any,
  isNewConversation?: boolean,
): boolean {
  switch (triggerType) {
    case "ad_click": {
      // Support both single values (legacy) and arrays
      const campaignIds = (Array.isArray(triggerConfig.campaignIds) ? triggerConfig.campaignIds : triggerConfig.campaignId ? [triggerConfig.campaignId] : []) as string[];
      const sourceIds = (Array.isArray(triggerConfig.sourceIds) ? triggerConfig.sourceIds : triggerConfig.sourceId ? [triggerConfig.sourceId] : []) as string[];
      const textMatches = (Array.isArray(triggerConfig.textMatches) ? triggerConfig.textMatches : triggerConfig.textMatch ? [triggerConfig.textMatch] : []) as string[];
      const logic = (triggerConfig.triggerLogic as string) ?? "or";
      const msgBody = (message?.text?.body ?? "") as string;
      const refSourceId = referral ? String(referral.source_id ?? "") : "";

      // Evaluate each group
      const checks: Record<string, boolean | undefined> = {
        campaignMatch: campaignIds.length > 0 ? (!!referral && campaignIds.some(id => refSourceId === id.trim())) : undefined,
        sourceMatch: sourceIds.length > 0 ? (!!referral && sourceIds.some(id => refSourceId === id.trim())) : undefined,
        textMatch: textMatches.length > 0 ? textMatches.some(t => msgBody.includes(t.trim())) : undefined,
        newConversation: isNewConversation ?? false,
      };

      const configured = Object.entries(checks).filter(([, v]) => v !== undefined);

      if (configured.length === 0) {
        return !!referral || !!isNewConversation;
      }

      if (logic === "and") {
        const allMatch = configured.every(([, v]) => v === true);
        console.log(`[automation] ad_click AND: ${configured.map(([k, v]) => `${k}=${v}`).join(", ")} → ${allMatch}`);
        return allMatch;
      } else {
        const anyMatch = configured.some(([, v]) => v === true);
        console.log(`[automation] ad_click OR: ${configured.map(([k, v]) => `${k}=${v}`).join(", ")} → ${anyMatch}`);
        return anyMatch;
      }
    }

    case "website": {
      // Referral with source_url matching config
      if (!referral) return false;
      const sourceUrl = (referral.source_url ?? "") as string;
      const contains = triggerConfig.sourceUrlContains as string | undefined;
      if (!contains) return true; // no filter = match any website referral
      return sourceUrl.includes(contains);
    }

    case "text_match": {
      // Match exact message text
      const msgBody = (message?.text?.body ?? "") as string;
      const exactText = triggerConfig.exactText as string | undefined;
      if (exactText) return msgBody.trim() === exactText.trim();
      const containsText = triggerConfig.containsText as string | undefined;
      if (containsText) return msgBody.includes(containsText);
      return false;
    }

    case "direct_wa": {
      // No referral = direct WhatsApp message
      return !referral;
    }

    case "manual": {
      // Manual triggers are never auto-fired from webhook
      return false;
    }

    default:
      return false;
  }
}

// ── Tree walking ────────────────────────────────────────────────────────────

interface ExecutionContext {
  db: Database;
  phone: string;
  conversationId: number;
  message: any;
  referral: Record<string, unknown> | null;
  env: any;
  executionId: number;
  workflowId: number;
  debugMode: boolean;
  executionCtx?: { waitUntil(promise: Promise<any>): void };
  nodes: AutomationNode[];
  childrenMap: Map<number, AutomationNode[]>;
}

type WalkResult = "continue" | "waiting";

function buildChildrenMap(nodes: AutomationNode[]): Map<number, AutomationNode[]> {
  const map = new Map<number, AutomationNode[]>();
  for (const node of nodes) {
    if (node.parentNodeId !== null) {
      const siblings = map.get(node.parentNodeId) ?? [];
      siblings.push(node);
      map.set(node.parentNodeId, siblings);
    }
  }
  // Sort children by position
  for (const [key, children] of map) {
    children.sort((a, b) => a.position - b.position);
  }
  return map;
}

async function walkNode(ctx: ExecutionContext, node: AutomationNode): Promise<WalkResult> {
  const config = node.config as Record<string, unknown>;

  switch (node.nodeType) {
    case "action": {
      await executeAction(ctx, config);
      // Continue to children
      const children = ctx.childrenMap.get(node.id) ?? [];
      for (const child of children) {
        const result = await walkNode(ctx, child);
        if (result === "waiting") return "waiting";
      }
      return "continue";
    }

    case "wait": {
      // Set execution to waiting and store current node
      const delayMs = (config.delayMinutes as number ?? 0) * 60 * 1000;
      const resumeAt = delayMs > 0 ? new Date(Date.now() + delayMs) : null;

      await ctx.db
        .update(automationExecutionsTable)
        .set({
          status: "waiting",
          currentNodeId: node.id,
          resumeAt,
        })
        .where(eq(automationExecutionsTable.id, ctx.executionId));

      return "waiting";
    }

    case "branch": {
      // ── v2 dispatch: check if first condition child has version: 2 ──
      const branchChildren = ctx.childrenMap.get(node.id) ?? [];
      const firstCondChild = branchChildren.find((c) => c.nodeType === "condition");
      if (firstCondChild) {
        const firstCondConfig = firstCondChild.config as Record<string, unknown>;
        if (firstCondConfig.version === 2) {
          return walkBranchV2(ctx, node, branchChildren);
        }
      }

      // ── v1 code path (unchanged) ──
      // Evaluate a field from context/message, then find matching condition child
      const field = config.field as string;
      const value = resolveField(ctx, field);

      const children = ctx.childrenMap.get(node.id) ?? [];
      // Children of a branch should be condition nodes
      let matched = false;
      for (const condChild of children) {
        if (condChild.nodeType === "condition") {
          const condConfig = condChild.config as Record<string, unknown>;
          if (evaluateCondition(value, condConfig)) {
            matched = true;
            // Walk the condition node's children
            const condChildren = ctx.childrenMap.get(condChild.id) ?? [];
            for (const cc of condChildren) {
              const result = await walkNode(ctx, cc);
              if (result === "waiting") return "waiting";
            }
            break; // First match wins
          }
        }
      }

      // If no condition matched, look for a default condition
      if (!matched) {
        for (const condChild of children) {
          if (condChild.nodeType === "condition") {
            const condConfig = condChild.config as Record<string, unknown>;
            if (condConfig.operator === "default") {
              const condChildren = ctx.childrenMap.get(condChild.id) ?? [];
              for (const cc of condChildren) {
                const result = await walkNode(ctx, cc);
                if (result === "waiting") return "waiting";
              }
              break;
            }
          }
        }
      }

      return "continue";
    }

    case "condition": {
      // Standalone condition (not under branch) — check and walk children if true
      const field = config.field as string;
      const value = resolveField(ctx, field);

      if (evaluateCondition(value, config)) {
        const children = ctx.childrenMap.get(node.id) ?? [];
        for (const child of children) {
          const result = await walkNode(ctx, child);
          if (result === "waiting") return "waiting";
        }
      }
      return "continue";
    }

    default:
      // Unknown node type — skip and continue
      console.warn(`[automation] Unknown node type: ${node.nodeType}`);
      return "continue";
  }
}

// ── Field resolution ────────────────────────────────────────────────────────

function resolveField(ctx: ExecutionContext, field: string): unknown {
  if (!field) return undefined;

  // Support dot-notation paths like "referral.source_url" or "message.text.body"
  const parts = field.split(".");
  let current: any = {
    phone: ctx.phone,
    conversationId: ctx.conversationId,
    message: ctx.message,
    referral: ctx.referral,
  };

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

// ── Condition evaluation ────────────────────────────────────────────────────

export function evaluateCondition(value: unknown, config: Record<string, unknown>): boolean {
  const operator = config.operator as string;
  const expected = config.value;

  switch (operator) {
    case "eq":
      return String(value) === String(expected);
    case "neq":
      return String(value) !== String(expected);
    case "contains":
      return typeof value === "string" && typeof expected === "string" && value.includes(expected);
    case "exists":
      return value !== null && value !== undefined;
    case "not_exists":
      return value === null || value === undefined;
    case "default":
      return true;
    default:
      return false;
  }
}

// ── Variable resolution ─────────────────────────────────────────────────────

/** Resolve {{variable}} placeholders in a string using execution context */
async function resolveVariables(text: string, ctx: ExecutionContext): Promise<string> {
  // Get contact name: try message data, then look up from conversation
  let contactName = ctx.message?.contacts?.[0]?.profile?.name
    ?? ctx.message?.contact_name
    ?? "";

  if (!contactName) {
    try {
      const conv = await ctx.db.query.conversationsTable.findFirst({
        where: eq(conversationsTable.phoneNumber, ctx.phone),
      });
      contactName = conv?.contactName ?? "";
    } catch {
      // ignore lookup failure
    }
  }

  // Load flow submission data for {{flow.*}} variables
  let flowData: Record<string, unknown> = {};
  if (text.includes("{{flow.")) {
    const submission = await loadFlowSubmission(ctx.db, ctx.phone);
    if (submission) flowData = submission;
  }

  const variables: Record<string, string> = {
    // User info
    "{{user.name}}": contactName || ((flowData.name as string) ?? ""),
    "{{user.phone}}": ctx.phone,
    // Ad/referral data
    "{{ad.headline}}": (ctx.referral?.headline as string) ?? "",
    "{{ad.source_url}}": (ctx.referral?.source_url as string) ?? "",
    "{{ad.campaign_name}}": (ctx.referral?.campaign_name as string) ?? "",
    "{{ad.source_id}}": (ctx.referral?.source_id as string) ?? "",
  };

  // Add all flow fields as {{flow.fieldname}}
  for (const [key, value] of Object.entries(flowData)) {
    if (key.startsWith("_")) continue; // skip internal fields like _waPhone
    variables[`{{flow.${key}}}`] = String(value ?? "");
  }

  let result = text;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

/** Deep-resolve all {{variable}} strings in a components array */
async function resolveComponentVariables(components: any[], ctx: ExecutionContext): Promise<any[]> {
  const resolved = await resolveVariables(JSON.stringify(components), ctx);
  return JSON.parse(resolved);
}

// ── Record outbound message in DB ───────────────────────────────────────────

async function recordOutboundMessage(
  ctx: ExecutionContext,
  waMessageId: string,
  messageType: "text" | "image" | "audio" | "video" | "document" | "sticker" | "location" | "contacts" | "reaction" | "unsupported",
  body: string,
): Promise<void> {
  try {
    await ctx.db.insert(messagesTable).values({
      conversationId: ctx.conversationId,
      waMessageId,
      direction: "outbound",
      messageType,
      body,
      status: "sent",
      timestamp: new Date(),
    });
    // Update conversation lastMessage
    await ctx.db
      .update(conversationsTable)
      .set({ lastMessage: body, lastMessageAt: new Date() })
      .where(eq(conversationsTable.id, ctx.conversationId));
  } catch (err: any) {
    console.warn(`[automation] Failed to record outbound message: ${err.message}`);
  }
}

// ── Action execution ────────────────────────────────────────────────────────

async function executeAction(ctx: ExecutionContext, config: Record<string, unknown>): Promise<void> {
  const actionType = config.actionType as string;
  const accessToken = ctx.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = ctx.env.WHATSAPP_PHONE_NUMBER_ID;

  switch (actionType) {
    case "send_template": {
      const templateName = config.templateName as string;
      const languageCode = (config.languageCode as string) ?? "en";
      const rawComponents = (config.components as any[]) ?? [];
      // Resolve {{user.name}}, {{user.phone}}, {{ad.*}} variables
      const components = rawComponents.length > 0
        ? await resolveComponentVariables(rawComponents, ctx)
        : [];

      const payload: any = {
        messaging_product: "whatsapp",
        to: ctx.phone,
        type: "template",
        template: { name: templateName, language: { code: languageCode } },
      };
      if (components.length > 0) payload.template.components = components;

      const result = await callWhatsAppAPI(payload, accessToken, phoneNumberId);
      const msgId = result?.messages?.[0]?.id ?? `auto_${Date.now()}`;
      await recordOutboundMessage(ctx, msgId, "text", `[Template: ${templateName}]`);
      break;
    }

    case "send_text": {
      const text = config.text as string;
      if (!text) return;

      const result = await callWhatsAppAPI(
        {
          messaging_product: "whatsapp",
          to: ctx.phone,
          type: "text",
          text: { body: text },
        },
        accessToken,
        phoneNumberId,
      );
      const msgId = result?.messages?.[0]?.id ?? `auto_${Date.now()}`;
      await recordOutboundMessage(ctx, msgId, "text", text);
      break;
    }

    case "send_flow": {
      const flowId = config.flowId as string;
      const ctaText = (config.ctaText as string) ?? "Get Started";
      const messageBody = (config.messageBody as string) ?? "Tap below to continue";
      const header = config.header as string | undefined;

      const interactive: any = {
        type: "flow",
        body: { text: messageBody },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: (config.flowToken as string) || "UNUSED",
            flow_id: flowId,
            flow_cta: ctaText,
            flow_action: "navigate",
          },
        },
      };
      if (header) {
        interactive.header = { type: "text", text: header };
      }

      await callWhatsAppAPI(
        {
          messaging_product: "whatsapp",
          to: ctx.phone,
          type: "interactive",
          interactive,
        },
        accessToken,
        phoneNumberId,
      );
      break;
    }

    default:
      console.warn(`[automation] Unknown action type: ${actionType}`);
  }
}

// ── v2 Branch Orchestrator ──────────────────────────────────────────────────

/** Budget (ms) for the entire v2 evaluation pipeline. */
// No timeout — execution steps wait as long as needed (user may take hours to complete a flow)

/**
 * Extract the Flow response payload from a WhatsApp interactive nfm_reply message.
 * Returns the parsed object or null if missing/unparseable.
 */
export function extractFlowPayload(message: any): Record<string, unknown> | null {
  try {
    const jsonStr = message?.interactive?.nfm_reply?.response_json;
    if (typeof jsonStr !== "string") return null;
    const parsed = JSON.parse(jsonStr);
    // Filter out flow_token — it's not a form field
    const { flow_token, ...fields } = parsed;
    // If only flow_token was present (no real fields), return null
    if (Object.keys(fields).length === 0) return null;
    return fields;
  } catch {
    return null;
  }
}

/**
 * Load flow submission data from DB for a given phone number.
 * Used when resuming a waiting execution — the actual form data
 * is in flow_submissions, not in the webhook nfm_reply payload.
 */
export async function loadFlowSubmission(
  db: Database,
  phone: string,
  afterTimestamp?: Date,
): Promise<Record<string, unknown> | null> {
  try {
    const submissions = await db
      .select()
      .from(flowSubmissionsTable)
      .where(
        afterTimestamp
          ? and(
              eq(flowSubmissionsTable.waPhone, phone),
              gt(flowSubmissionsTable.createdAt, afterTimestamp),
            )
          : eq(flowSubmissionsTable.waPhone, phone)
      )
      .orderBy(desc(flowSubmissionsTable.createdAt))
      .limit(1);

    if (submissions.length === 0) return null;

    const sub = submissions[0];
    const responses = sub.screenResponses as Record<string, unknown> ?? {};
    // Remove internal fields
    const { _waPhone, prefilled_name, ...fields } = responses;
    return Object.keys(fields).length > 0 ? fields : null;
  } catch (err: any) {
    console.error("[automation] Failed to load flow submission:", err.message);
    return null;
  }
}

/**
 * Handle a FAILED v2 condition result: log, update execution context, flush decision log, walk default branch.
 */
async function handleV2Failed(
  ctx: ExecutionContext,
  children: AutomationNode[],
  reason: FailedReason,
  startMs?: number,
): Promise<WalkResult> {
  console.warn(`[automation] v2 condition FAILED:${reason} — ${FAILED_MESSAGES[reason]}`);

  // Update execution context JSONB with condition_failures entry
  try {
    await ctx.db
      .update(automationExecutionsTable)
      .set({
        context: {
          condition_failures: [{ reason, message: FAILED_MESSAGES[reason], timestamp: new Date().toISOString() }],
        },
      })
      .where(eq(automationExecutionsTable.id, ctx.executionId));
  } catch {
    // Best-effort: don't block execution if context update fails
  }

  // Flush decision log for early failures
  const record: DecisionRecord = {
    workflowId: ctx.workflowId,
    executionId: ctx.executionId,
    nodeId: null,
    schemaVersion: null,
    logic: null,
    durationMs: startMs ? Date.now() - startMs : 0,
    decisions: [],
    finalResult: "FAILED",
    failedReason: reason,
    branchTaken: "default",
  };

  if (shouldLog(ctx.debugMode, "FAILED")) {
    ctx.executionCtx?.waitUntil(
      flushDecisionLog(ctx.db, record).catch((err) =>
        console.error("[decision-log] Write failed:", err),
      ),
    );
  }

  // Walk default branch
  return walkDefaultBranch(ctx, children);
}

/**
 * Walk the default branch child (operator === "default").
 */
async function walkDefaultBranch(
  ctx: ExecutionContext,
  children: AutomationNode[],
): Promise<WalkResult> {
  for (const child of children) {
    if (child.nodeType === "condition") {
      const childConfig = child.config as Record<string, unknown>;
      if (childConfig.operator === "default") {
        const defaultChildren = ctx.childrenMap.get(child.id) ?? [];
        for (const dc of defaultChildren) {
          const result = await walkNode(ctx, dc);
          if (result === "waiting") return "waiting";
        }
        return "continue";
      }
    }
  }
  return "continue";
}

/**
 * v2 branch orchestrator: extract payload -> load schema -> map -> evaluate -> route.
 * Enforces a 200ms budget across the entire pipeline.
 */
export async function walkBranchV2(
  ctx: ExecutionContext,
  branchNode: AutomationNode,
  children: AutomationNode[],
): Promise<WalkResult> {
  const startMs = Date.now();

  // Step 1: Get flow response data
  // Try 1: from webhook message (interactive nfm_reply)
  let payload = extractFlowPayload(ctx.message);

  // Try 2: from flow_submissions table — only submissions AFTER this execution started
  if (!payload) {
    const [execution] = await ctx.db
      .select({ startedAt: automationExecutionsTable.startedAt })
      .from(automationExecutionsTable)
      .where(eq(automationExecutionsTable.id, ctx.executionId))
      .limit(1);
    payload = await loadFlowSubmission(ctx.db, ctx.phone, execution?.startedAt ?? undefined);
  }

  // No flow data available — pause and wait for flow completion
  if (!payload) {
    console.log(`[automation] Execution ${ctx.executionId} paused at branch ${branchNode.id} — waiting for flow response`);
    await ctx.db
      .update(automationExecutionsTable)
      .set({ status: "waiting", currentNodeId: branchNode.id })
      .where(eq(automationExecutionsTable.id, ctx.executionId));
    return "waiting";
  }

  console.log(`[automation] Execution ${ctx.executionId} — flow data found: ${Object.keys(payload).join(", ")}`);

  // Step 2: Find v2 condition child
  const condChild = children.find((c) => c.nodeType === "condition" && (c.config as Record<string, unknown>).version === 2);
  if (!condChild) {
    return handleV2Failed(ctx, children, "MAPPING_FAILED", startMs);
  }
  const v2Config = condChild.config as unknown as ConditionV2Config;

  // Step 3: Load schema
  let schema;
  try {
    schema = await getSchemaByFlowIdAndVersion(ctx.db, v2Config.flow_id, v2Config.schema_version);
  } catch {
    return handleV2Failed(ctx, children, "SCHEMA_LOAD_FAILED", startMs);
  }
  if (!schema) {
    return handleV2Failed(ctx, children, "SCHEMA_NOT_FOUND", startMs);
  }

  // Step 4: Map payload against schema fields
  const mapResult = mapWebhookPayload(payload, schema.fields);

  // Step 5: Evaluate conditions
  const decisions: DecisionEntry[] = [];
  let lastFailed: ConditionResult | null = null;
  let evalResult: ConditionResult = v2Config.logic === "and"
    ? { result: "TRUE" }
    : { result: "FALSE" };

  for (const entry of v2Config.conditions) {
    const mapped = mapResult.fields.find((f) => f.field_key === entry.field_key);
    const condResult = evaluateSingleCondition(entry, mapResult.fields, schema.fields);
    decisions.push(buildDecisionEntry(entry, mapped, condResult));

    if (v2Config.logic === "and") {
      if (condResult.result === "FALSE") { evalResult = { result: "FALSE" }; break; }
      if (condResult.result === "FAILED") { evalResult = condResult; break; }
    } else {
      if (condResult.result === "TRUE") { evalResult = { result: "TRUE" }; break; }
      if (condResult.result === "FAILED") lastFailed = condResult;
    }
  }

  if (v2Config.logic === "or" && evalResult.result === "FALSE" && lastFailed) {
    evalResult = lastFailed;
  }

  // Step 6: Log decision
  const branchTaken = evalResult.result === "TRUE" ? condChild.id.toString() : "default";
  const decisionRecord: DecisionRecord = {
    workflowId: ctx.workflowId,
    executionId: ctx.executionId,
    nodeId: condChild.id.toString(),
    schemaVersion: v2Config.schema_version,
    logic: v2Config.logic,
    durationMs: Date.now() - startMs,
    decisions,
    finalResult: evalResult.result,
    failedReason: evalResult.result === "FAILED" ? evalResult.reason : undefined,
    branchTaken,
  };

  if (shouldLog(ctx.debugMode, decisionRecord.finalResult)) {
    ctx.executionCtx?.waitUntil(
      flushDecisionLog(ctx.db, decisionRecord).catch((err) =>
        console.error("[decision-log] Write failed:", err),
      ),
    );
  }

  // Step 7: Route to matching branch
  if (evalResult.result === "TRUE") {
    const matchChildren = ctx.childrenMap.get(condChild.id) ?? [];
    console.log(`[automation] Condition ${condChild.id} matched — walking ${matchChildren.length} children: ${matchChildren.map(c => `${c.nodeType}(${c.id})`).join(", ")}`);
    for (const mc of matchChildren) {
      try {
        console.log(`[automation] Executing child ${mc.nodeType}(${mc.id}) config: ${JSON.stringify(mc.config).substring(0, 200)}`);
        const result = await walkNode(ctx, mc);
        console.log(`[automation] Child ${mc.nodeType}(${mc.id}) completed with result: ${result}`);
        if (result === "waiting") return "waiting";
      } catch (err: any) {
        console.error(`[automation] Error executing child node ${mc.id} (${mc.nodeType}):`, err.message);
        throw err;
      }
    }
    return "continue";
  }

  if (evalResult.result === "FAILED") {
    return handleV2Failed(ctx, children, evalResult.reason, startMs);
  }

  return walkDefaultBranch(ctx, children);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function markExecution(db: Database, executionId: number, status: "completed" | "failed"): Promise<void> {
  await db
    .update(automationExecutionsTable)
    .set({
      status,
      completedAt: new Date(),
    })
    .where(eq(automationExecutionsTable.id, executionId));
}

// ── Resume waiting executions (called when flow response arrives) ────────────

export async function resumeWaitingExecutions(
  db: Database,
  phone: string,
  message: any,
  env: any,
  executionCtx?: { waitUntil(promise: Promise<any>): void },
): Promise<void> {
  // Find waiting executions for this phone
  const waiting = await db
    .select()
    .from(automationExecutionsTable)
    .where(
      and(
        eq(automationExecutionsTable.phoneNumber, phone),
        eq(automationExecutionsTable.status, "waiting"),
      )
    );

  if (waiting.length === 0) return;

  for (const execution of waiting) {
    if (!execution.currentNodeId) continue;

    console.log(`[automation] Resuming execution ${execution.id} for phone=${phone} at node=${execution.currentNodeId}`);

    try {
      // Load workflow
      const [workflow] = await db
        .select()
        .from(automationWorkflowsTable)
        .where(eq(automationWorkflowsTable.id, execution.workflowId))
        .limit(1);
      if (!workflow) continue;

      // Load nodes and build tree
      const nodes = await db
        .select()
        .from(automationNodesTable)
        .where(eq(automationNodesTable.workflowId, execution.workflowId));

      const childrenMap = buildChildrenMap(nodes);
      const branchNode = nodes.find(n => n.id === execution.currentNodeId);
      if (!branchNode) continue;

      // Set back to running
      await db
        .update(automationExecutionsTable)
        .set({ status: "running" })
        .where(eq(automationExecutionsTable.id, execution.id));

      const ctx: ExecutionContext = {
        db,
        phone,
        conversationId: execution.conversationId ?? 0,
        message, // This now has the flow response (nfm_reply)
        referral: null,
        env,
        executionId: execution.id,
        workflowId: execution.workflowId,
        debugMode: (workflow as any).debugMode ?? false,
        executionCtx,
        nodes,
        childrenMap,
      };

      // Resume from the branch node
      const branchChildren = childrenMap.get(branchNode.id) ?? [];
      const result = await walkBranchV2(ctx, branchNode, branchChildren);

      if (result !== "waiting") {
        await markExecution(db, execution.id, "completed");
        if (executionCtx) {
          executionCtx.waitUntil(
            evaluateKillSwitch(db, execution.workflowId).catch(err =>
              console.error(`[kill-switch] Error:`, err)
            )
          );
        }
      }
    } catch (err: any) {
      console.error(`[automation] Error resuming execution ${execution.id}:`, err.message);
      await markExecution(db, execution.id, "failed").catch(() => {});
    }
  }
}
