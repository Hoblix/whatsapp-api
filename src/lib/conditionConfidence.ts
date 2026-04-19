/**
 * Condition confidence and staleness logic.
 *
 * Pure functions for determining how trustworthy a v2 condition node's
 * configuration is relative to the current schema.
 */

import type { FlowFieldEntry } from "./validateTree";

// ── Types ────────────────────────────────────────────────────────────────────

export type ConfidenceLevel = "valid" | "warning" | "unknown";

interface ConditionV2Config {
  version: 2;
  schema_version: string;
  flow_id: string;
  logic: "and" | "or";
  conditions: { field_key: string; operator: string; value: string }[];
}

// ── getConditionConfidence ────────────────────────────────────────────────────

/**
 * Determine confidence level for a v2 condition node.
 *
 * - "unknown"  when schemaFields is empty (no schema loaded)
 * - "warning"  when schema_version differs from currentFlowVersion (BUI-10/11)
 * - "warning"  when any condition's field_key or value doesn't match schema
 * - "valid"    when everything matches
 */
export function getConditionConfidence(
  config: ConditionV2Config,
  schemaFields: FlowFieldEntry[],
  currentFlowVersion: string | null,
): ConfidenceLevel {
  // No schema loaded
  if (schemaFields.length === 0) {
    return "unknown";
  }

  // Version mismatch
  if (
    currentFlowVersion !== null &&
    config.schema_version !== currentFlowVersion
  ) {
    return "warning";
  }

  // Check each non-empty condition against schema
  for (const cond of config.conditions) {
    // Skip partial entries
    if (!cond.field_key || !cond.value) continue;

    const field = schemaFields.find((f) => f.field_key === cond.field_key);
    if (!field) return "warning";
    if (!field.values.includes(cond.value)) return "warning";
  }

  return "valid";
}

// ── daysAgo ──────────────────────────────────────────────────────────────────

/**
 * Calculate the number of days between a given date and now (BUI-09 staleness).
 */
export function daysAgo(date: Date): number {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}
