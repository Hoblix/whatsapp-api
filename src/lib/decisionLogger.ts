/**
 * Decision Logger — structured logging for v2 condition evaluations.
 *
 * Captures per-condition decision entries during walkBranchV2 and flushes
 * them asynchronously via waitUntil() to the automation_condition_logs table.
 */

import type { Database } from "./db";
import type { ConditionV2Entry, ConditionResult } from "./conditionEngineV2.types";
import type { MappedField } from "./webhookMapper";
import { automationConditionLogsTable } from "./schema/automations";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DecisionEntry {
  field_key: string;
  raw_value: string | null;
  normalized_value: string | null;
  operator: string;
  expected_value: string;
  result: "TRUE" | "FALSE" | "FAILED";
  failed_reason?: string;
}

export interface DecisionRecord {
  workflowId: number;
  executionId: number;
  nodeId: string | null;
  schemaVersion: string | null;
  logic: "and" | "or" | null;
  durationMs: number;
  decisions: DecisionEntry[];
  finalResult: "TRUE" | "FALSE" | "FAILED";
  failedReason?: string;
  branchTaken: string | null;
}

// ── Functions ──────────────────────────────────────────────────────────────

/**
 * Gate whether a decision record should be flushed to the DB.
 * Failures are always logged; successes/non-failures only in debug mode.
 */
export function shouldLog(debugMode: boolean, result: string): boolean {
  if (result === "FAILED") return true;
  return debugMode;
}

/**
 * Build a single DecisionEntry from condition evaluation inputs/outputs.
 */
export function buildDecisionEntry(
  entry: ConditionV2Entry,
  mapped: MappedField | undefined,
  condResult: ConditionResult,
): DecisionEntry {
  const de: DecisionEntry = {
    field_key: entry.field_key,
    raw_value: mapped ? String(mapped.raw_value) : null,
    normalized_value: mapped?.normalized_value ?? null,
    operator: entry.operator,
    expected_value: entry.value,
    result: condResult.result,
  };

  if (condResult.result === "FAILED") {
    de.failed_reason = condResult.reason;
  }

  return de;
}

/**
 * Flush a decision record to the automation_condition_logs table.
 * Designed to be called inside waitUntil() so it never blocks the response.
 */
export async function flushDecisionLog(
  db: Database,
  record: DecisionRecord,
): Promise<void> {
  await db
    .insert(automationConditionLogsTable)
    .values({
      workflowId: record.workflowId,
      executionId: record.executionId,
      nodeId: record.nodeId,
      schemaVersion: record.schemaVersion,
      logic: record.logic,
      durationMs: record.durationMs,
      decisions: record.decisions,
      finalResult: record.finalResult,
      failedReason: record.failedReason ?? null,
      branchTaken: record.branchTaken,
    })
    .returning();
}
