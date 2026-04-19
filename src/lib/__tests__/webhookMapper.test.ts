import { describe, it, expect } from "vitest";
import {
  mapWebhookPayload,
  applyTransforms,
  type MappedField,
  type MapResult,
} from "../webhookMapper";
import type { FlowFieldEntry } from "../schema/flow-field-schemas";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeField(key: string, overrides?: Partial<FlowFieldEntry>): FlowFieldEntry {
  return {
    field_key: key,
    label: key.replace(/_/g, " "),
    type: "string",
    values: [],
    screen_id: "SCREEN_1",
    ...overrides,
  };
}

// ── MAP-01: Auto-confirm ─────────────────────────────────────────────────────

describe("MAP-01: Auto-confirm matching payload keys", () => {
  it("marks schema field present in payload as confirmed", () => {
    const schema = [makeField("user_choice", { type: "enum", values: ["a", "b"] })];
    const payload = { user_choice: "get_pricing" };

    const result = mapWebhookPayload(payload, schema);

    const field = result.fields.find((f) => f.field_key === "user_choice")!;
    expect(field).toBeDefined();
    expect(field.status).toBe("confirmed");
    expect(field.raw_value).toBe("get_pricing");
    expect(field.normalized_value).toBe("get_pricing");
  });

  it("confirms multiple matching fields", () => {
    const schema = [makeField("name"), makeField("email")];
    const payload = { name: "Alice", email: "ALICE@TEST.COM" };

    const result = mapWebhookPayload(payload, schema);

    expect(result.fields).toHaveLength(2);
    expect(result.fields.every((f) => f.status === "confirmed")).toBe(true);
  });
});

// ── MAP-02: Status tracking ─────────────────────────────────────────────────

describe("MAP-02: Status tracking", () => {
  it("tracks payload keys not in schema as unmapped_keys", () => {
    const schema = [makeField("name")];
    const payload = { name: "Alice", extra_field: "surprise" };

    const result = mapWebhookPayload(payload, schema);

    expect(result.unmapped_keys).toContain("extra_field");
    expect(result.fields.find((f) => f.field_key === "extra_field")).toBeUndefined();
  });

  it("marks schema fields missing from payload as missing", () => {
    const schema = [makeField("name"), makeField("phone")];
    const payload = { name: "Alice" };

    const result = mapWebhookPayload(payload, schema);

    const phone = result.fields.find((f) => f.field_key === "phone")!;
    expect(phone.status).toBe("missing");
    expect(phone.raw_value).toBeNull();
    expect(phone.normalized_value).toBeNull();
  });

  it("returns all schema fields as missing when payload is empty", () => {
    const schema = [makeField("a"), makeField("b")];
    const result = mapWebhookPayload({}, schema);

    expect(result.fields.every((f) => f.status === "missing")).toBe(true);
    expect(result.unmapped_keys).toEqual([]);
  });

  it("returns all payload keys as unmapped when schema is empty", () => {
    const result = mapWebhookPayload({ x: 1, y: 2 }, []);

    expect(result.fields).toEqual([]);
    expect(result.unmapped_keys).toEqual(expect.arrayContaining(["x", "y"]));
  });
});

// ── MAP-03: Transform pipeline ──────────────────────────────────────────────

describe("MAP-03: Transform pipeline", () => {
  it("applies default transforms (trim + lowercase)", () => {
    const schema = [makeField("name")];
    const payload = { name: "  Hello World  " };

    const result = mapWebhookPayload(payload, schema);

    const field = result.fields[0];
    expect(field.normalized_value).toBe("hello world");
    expect(field.transforms_applied).toEqual(["trim", "lowercase"]);
  });

  it("applies only specified transforms", () => {
    const schema = [makeField("name")];
    const payload = { name: "  Hello World  " };

    const result = mapWebhookPayload(payload, schema, ["trim"]);

    expect(result.fields[0].normalized_value).toBe("Hello World");
    expect(result.fields[0].transforms_applied).toEqual(["trim"]);
  });

  it("applies transforms sequentially", () => {
    const value = applyTransforms("  HELLO  ", ["trim", "lowercase"]);
    expect(value).toBe("hello");
  });

  it("silently skips unknown transform names", () => {
    const value = applyTransforms("hello", ["trim", "nonexistent", "lowercase"]);
    expect(value).toBe("hello");
  });

  it("supports uppercase transform", () => {
    const value = applyTransforms("hello", ["uppercase"]);
    expect(value).toBe("HELLO");
  });

  it("supports toString transform for numeric values", () => {
    const schema = [makeField("age")];
    const payload = { age: 42 };

    const result = mapWebhookPayload(payload, schema, ["toString", "trim"]);

    expect(result.fields[0].normalized_value).toBe("42");
    expect(result.fields[0].status).toBe("confirmed");
  });
});

// ── MAP-04: Null handling ───────────────────────────────────────────────────

describe("MAP-04: Null handling", () => {
  it("marks null payload value as missing with no transforms", () => {
    const schema = [makeField("user_choice")];
    const payload = { user_choice: null };

    const result = mapWebhookPayload(payload, schema);

    const field = result.fields[0];
    expect(field.status).toBe("missing");
    expect(field.raw_value).toBeNull();
    expect(field.normalized_value).toBeNull();
    expect(field.transforms_applied).toEqual([]);
  });

  it("marks undefined payload value as missing with no transforms", () => {
    const schema = [makeField("user_choice")];
    const payload = { user_choice: undefined };

    const result = mapWebhookPayload(payload, schema);

    const field = result.fields[0];
    expect(field.status).toBe("missing");
    expect(field.normalized_value).toBeNull();
    expect(field.transforms_applied).toEqual([]);
  });

  it("marks absent payload key as missing with no transforms", () => {
    const schema = [makeField("user_choice")];
    const payload = {};

    const result = mapWebhookPayload(payload, schema);

    const field = result.fields[0];
    expect(field.status).toBe("missing");
    expect(field.raw_value).toBeNull();
    expect(field.normalized_value).toBeNull();
    expect(field.transforms_applied).toEqual([]);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("filters flow_token from payload before mapping", () => {
    const schema = [makeField("name")];
    const payload = { name: "Alice", flow_token: "abc123" };

    const result = mapWebhookPayload(payload, schema);

    expect(result.fields.find((f) => f.field_key === "flow_token")).toBeUndefined();
    expect(result.unmapped_keys).not.toContain("flow_token");
  });

  it("treats empty string as confirmed (not missing)", () => {
    const schema = [makeField("name")];
    const payload = { name: "" };

    const result = mapWebhookPayload(payload, schema);

    expect(result.fields[0].status).toBe("confirmed");
    expect(result.fields[0].normalized_value).toBe("");
  });

  it("coerces non-string values via String() before transforms", () => {
    const schema = [makeField("count")];
    const payload = { count: 123 };

    const result = mapWebhookPayload(payload, schema);

    expect(result.fields[0].status).toBe("confirmed");
    expect(result.fields[0].normalized_value).toBe("123");
  });

  it("handles boolean values", () => {
    const schema = [makeField("opted_in")];
    const payload = { opted_in: true };

    const result = mapWebhookPayload(payload, schema);

    expect(result.fields[0].status).toBe("confirmed");
    expect(result.fields[0].normalized_value).toBe("true");
  });
});
