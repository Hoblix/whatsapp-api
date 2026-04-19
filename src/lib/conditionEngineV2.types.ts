// ── v2 Condition Engine Types ────────────────────────────────────────────────

/**
 * Top-level configuration for a v2 condition node.
 * Stored on the automation node's `config` field at save time.
 */
export interface ConditionV2Config {
  version: 2;
  schema_version: string;
  flow_id: string;
  logic: "and" | "or";
  conditions: ConditionV2Entry[];
}

/**
 * A single condition entry: compare a mapped field value using an operator.
 */
export interface ConditionV2Entry {
  field_key: string;
  operator: "eq" | "neq";
  value: string;
}

/**
 * Reason codes for FAILED evaluation results.
 */
export type FailedReason =
  | "FIELD_MISSING"
  | "MAPPING_FAILED"
  | "VALUE_UNLISTED"
  | "SCHEMA_NOT_FOUND"
  | "SCHEMA_LOAD_FAILED"
  | "TIMEOUT";

/**
 * Three-state evaluation result: TRUE, FALSE, or FAILED with reason.
 */
export type ConditionResult =
  | { result: "TRUE" }
  | { result: "FALSE" }
  | { result: "FAILED"; reason: FailedReason; message: string };

/**
 * Human-readable messages for each FAILED reason.
 * Used in logs, execution records, and downstream UI.
 */
export const FAILED_MESSAGES: Record<FailedReason, string> = {
  FIELD_MISSING: "We couldn't find this answer in the user's response",
  MAPPING_FAILED: "The response format didn't match what we expected",
  VALUE_UNLISTED: "The user gave an answer we don't have a rule for",
  SCHEMA_NOT_FOUND: "This flow's response options haven't been loaded yet",
  SCHEMA_LOAD_FAILED: "Temporary error loading response options",
  TIMEOUT: "Took too long to evaluate -- used default path",
};
