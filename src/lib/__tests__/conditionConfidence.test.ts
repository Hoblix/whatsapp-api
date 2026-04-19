import { describe, it, expect } from "vitest";
import { getConditionConfidence, daysAgo } from "../conditionConfidence";
import type { FlowFieldEntry } from "../validateTree";

const SCHEMA_FIELDS: FlowFieldEntry[] = [
  {
    field_key: "interest",
    label: "Interest",
    type: "string",
    values: ["buy", "rent"],
    screen_id: "s1",
  },
];

// ── getConditionConfidence ────────────────────────────────────────────────────

describe("getConditionConfidence", () => {
  it('returns "unknown" when schemaFields is empty', () => {
    const config = {
      version: 2 as const,
      schema_version: "5.0",
      flow_id: "f1",
      logic: "and" as const,
      conditions: [{ field_key: "interest", operator: "eq" as const, value: "buy" }],
    };
    expect(getConditionConfidence(config, [], "5.0")).toBe("unknown");
  });

  it('returns "warning" when schema_version differs from currentFlowVersion', () => {
    const config = {
      version: 2 as const,
      schema_version: "4.0",
      flow_id: "f1",
      logic: "and" as const,
      conditions: [{ field_key: "interest", operator: "eq" as const, value: "buy" }],
    };
    expect(getConditionConfidence(config, SCHEMA_FIELDS, "5.0")).toBe("warning");
  });

  it('returns "warning" when a condition field_key is not in schema fields', () => {
    const config = {
      version: 2 as const,
      schema_version: "5.0",
      flow_id: "f1",
      logic: "and" as const,
      conditions: [{ field_key: "nonexistent", operator: "eq" as const, value: "x" }],
    };
    expect(getConditionConfidence(config, SCHEMA_FIELDS, "5.0")).toBe("warning");
  });

  it('returns "warning" when a condition value is not in field values array', () => {
    const config = {
      version: 2 as const,
      schema_version: "5.0",
      flow_id: "f1",
      logic: "and" as const,
      conditions: [{ field_key: "interest", operator: "eq" as const, value: "unknown" }],
    };
    expect(getConditionConfidence(config, SCHEMA_FIELDS, "5.0")).toBe("warning");
  });

  it('returns "valid" when all conditions match schema and version matches', () => {
    const config = {
      version: 2 as const,
      schema_version: "5.0",
      flow_id: "f1",
      logic: "and" as const,
      conditions: [{ field_key: "interest", operator: "eq" as const, value: "buy" }],
    };
    expect(getConditionConfidence(config, SCHEMA_FIELDS, "5.0")).toBe("valid");
  });

  it("skips conditions with empty field_key or value (partial entries)", () => {
    const config = {
      version: 2 as const,
      schema_version: "5.0",
      flow_id: "f1",
      logic: "and" as const,
      conditions: [
        { field_key: "", operator: "eq" as const, value: "" },
        { field_key: "interest", operator: "eq" as const, value: "buy" },
      ],
    };
    expect(getConditionConfidence(config, SCHEMA_FIELDS, "5.0")).toBe("valid");
  });
});

// ── daysAgo ──────────────────────────────────────────────────────────────────

describe("daysAgo", () => {
  it("returns 0 for today's date", () => {
    expect(daysAgo(new Date())).toBe(0);
  });

  it("returns 7 for a date 7 days ago", () => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    expect(daysAgo(d)).toBe(7);
  });

  it("returns correct value for arbitrary dates", () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    expect(daysAgo(d)).toBe(30);
  });
});
