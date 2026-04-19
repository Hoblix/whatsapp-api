import type { FlowFieldEntry } from "./schema/flow-field-schemas";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MappedField {
  field_key: string;
  raw_value: unknown;
  normalized_value: string | null;
  status: "confirmed" | "inferred" | "missing";
  transforms_applied: string[];
}

export interface MapResult {
  fields: MappedField[];
  unmapped_keys: string[]; // payload keys not in schema (informational)
}

// ── Transforms ───────────────────────────────────────────────────────────────

const TRANSFORMS: Record<string, (v: string) => string> = {
  trim: (v) => v.trim(),
  lowercase: (v) => v.toLowerCase(),
  uppercase: (v) => v.toUpperCase(),
  toString: (v) => String(v),
};

/**
 * Apply a list of transforms sequentially to a string value.
 * Unknown transform names are silently skipped.
 */
export function applyTransforms(value: string, transforms: string[]): string {
  let result = value;
  for (const name of transforms) {
    const fn = TRANSFORMS[name];
    if (fn) {
      result = fn(result);
    }
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Keys to always filter from the payload before mapping. */
const FILTERED_KEYS = new Set(["flow_token"]);

/**
 * Extract a value from the payload, distinguishing between absent key and
 * explicitly-set null/undefined.
 */
function extractValue(
  payload: Record<string, unknown>,
  key: string,
): { value: unknown; present: boolean } {
  if (!(key in payload)) {
    return { value: null, present: false };
  }
  return { value: payload[key], present: true };
}

// ── Main mapper ──────────────────────────────────────────────────────────────

/**
 * Map a webhook payload against schema fields.
 *
 * - Schema fields present in payload -> confirmed (transforms applied)
 * - Schema fields absent/null/undefined in payload -> missing (no transforms)
 * - Payload keys not in schema -> unmapped_keys
 * - flow_token is always filtered out
 */
export function mapWebhookPayload(
  payload: Record<string, unknown>,
  schemaFields: FlowFieldEntry[],
  transforms: string[] = ["trim", "lowercase"],
): MapResult {
  // Build a set of schema field keys for O(1) lookup
  const schemaKeySet = new Set(schemaFields.map((f) => f.field_key));

  // Filter payload keys
  const payloadKeys = Object.keys(payload).filter((k) => !FILTERED_KEYS.has(k));

  // Map each schema field
  const fields: MappedField[] = schemaFields.map((schemaField) => {
    const { value, present } = extractValue(payload, schemaField.field_key);

    // Null, undefined, or absent -> missing
    if (!present || value === null || value === undefined) {
      return {
        field_key: schemaField.field_key,
        raw_value: null,
        normalized_value: null,
        status: "missing" as const,
        transforms_applied: [],
      };
    }

    // Coerce non-string values to string before transforms
    const stringValue = typeof value === "string" ? value : String(value);
    const normalized = applyTransforms(stringValue, transforms);

    return {
      field_key: schemaField.field_key,
      raw_value: value,
      normalized_value: normalized,
      status: "confirmed" as const,
      transforms_applied: transforms.filter((t) => TRANSFORMS[t] !== undefined),
    };
  });

  // Collect unmapped keys (payload keys not in schema, excluding filtered)
  const unmapped_keys = payloadKeys.filter((k) => !schemaKeySet.has(k));

  return { fields, unmapped_keys };
}
