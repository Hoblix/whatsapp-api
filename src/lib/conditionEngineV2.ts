import type { MappedField } from "./webhookMapper";
import type { FlowFieldEntry } from "./schema/flow-field-schemas";
import type {
  ConditionV2Entry,
  ConditionResult,
  FailedReason,
} from "./conditionEngineV2.types";
import { FAILED_MESSAGES } from "./conditionEngineV2.types";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a FAILED result from a reason code. */
function failed(reason: FailedReason): ConditionResult {
  return { result: "FAILED", reason, message: FAILED_MESSAGES[reason] };
}

// ── Single Condition Evaluation ─────────────────────────────────────────────

/**
 * Evaluate a single condition entry against mapped fields and schema.
 *
 * Order of checks:
 *   1. FIELD_MISSING — mapped field absent or status "missing"
 *   2. MAPPING_FAILED — mapped field status "inferred"
 *   3. VALUE_UNLISTED — normalized value not in schema enum (before operator)
 *   4. Operator comparison (eq / neq)
 */
export function evaluateSingleCondition(
  entry: ConditionV2Entry,
  mappedFields: MappedField[],
  schemaFields: FlowFieldEntry[],
): ConditionResult {
  // 1. Find the mapped field
  const mapped = mappedFields.find((f) => f.field_key === entry.field_key);
  if (!mapped || mapped.status === "missing") {
    return failed("FIELD_MISSING");
  }

  // 2. Check inferred status -> MAPPING_FAILED
  if (mapped.status === "inferred") {
    return failed("MAPPING_FAILED");
  }

  // 3. VALUE_UNLISTED check (before operator evaluation)
  const schemaField = schemaFields.find((f) => f.field_key === entry.field_key);
  if (schemaField && schemaField.values.length > 0) {
    const normalizedValues = schemaField.values.map((v) =>
      v.trim().toLowerCase(),
    );
    if (
      mapped.normalized_value !== null &&
      !normalizedValues.includes(mapped.normalized_value)
    ) {
      return failed("VALUE_UNLISTED");
    }
  }

  // 4. Operator comparison
  const actual = mapped.normalized_value;
  const expected = entry.value.trim().toLowerCase();

  switch (entry.operator) {
    case "eq":
      return actual === expected ? { result: "TRUE" } : { result: "FALSE" };
    case "neq":
      return actual !== expected ? { result: "TRUE" } : { result: "FALSE" };
    default:
      return { result: "FALSE" };
  }
}

// ── Multi-Condition Evaluation ──────────────────────────────────────────────

/**
 * Evaluate multiple conditions with AND/OR short-circuit logic.
 *
 * AND: first FALSE -> FALSE; first FAILED -> FAILED; all TRUE -> TRUE
 * OR:  first TRUE -> TRUE; all FALSE -> FALSE; any FAILED (no TRUE) -> last FAILED
 *
 * Empty conditions: AND -> TRUE, OR -> FALSE
 */
export function evaluateConditionsV2(
  entries: ConditionV2Entry[],
  mappedFields: MappedField[],
  schemaFields: FlowFieldEntry[],
  logic: "and" | "or",
): ConditionResult {
  let lastFailed: ConditionResult | null = null;

  for (const entry of entries) {
    const result = evaluateSingleCondition(entry, mappedFields, schemaFields);

    if (logic === "and") {
      if (result.result === "FALSE") return { result: "FALSE" };
      if (result.result === "FAILED") return result;
    } else {
      // OR logic
      if (result.result === "TRUE") return { result: "TRUE" };
      if (result.result === "FAILED") lastFailed = result;
    }
  }

  if (logic === "and") return { result: "TRUE" };
  if (lastFailed) return lastFailed;
  return { result: "FALSE" };
}
