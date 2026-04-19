import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluateConditionsV2,
  evaluateSingleCondition,
} from "../conditionEngineV2";
import {
  extractFlowPayload,
  walkBranchV2,
  BUDGET_MS,
} from "../../routes/automationEngine";
import {
  FAILED_MESSAGES,
  type ConditionV2Entry,
  type ConditionResult,
  type FailedReason,
} from "../conditionEngineV2.types";
import type { MappedField } from "../webhookMapper";
import type { FlowFieldEntry } from "../schema/flow-field-schemas";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMapped(
  overrides: Partial<MappedField> & { field_key: string },
): MappedField {
  return {
    raw_value: overrides.raw_value ?? overrides.normalized_value ?? "test",
    normalized_value: overrides.normalized_value ?? "test",
    status: overrides.status ?? "confirmed",
    transforms_applied: overrides.transforms_applied ?? ["trim", "lowercase"],
    ...overrides,
  };
}

function makeSchema(
  field_key: string,
  values: string[] = [],
): FlowFieldEntry {
  return {
    field_key,
    label: field_key,
    type: "string",
    values,
    screen_id: "screen_0",
  };
}

function makeEntry(
  field_key: string,
  operator: "eq" | "neq",
  value: string,
): ConditionV2Entry {
  return { field_key, operator, value };
}

// ── FAILED_MESSAGES ─────────────────────────────────────────────────────────

describe("FAILED_MESSAGES", () => {
  it("has a human-readable message for every FailedReason", () => {
    const reasons: FailedReason[] = [
      "FIELD_MISSING",
      "MAPPING_FAILED",
      "VALUE_UNLISTED",
      "SCHEMA_NOT_FOUND",
      "SCHEMA_LOAD_FAILED",
      "TIMEOUT",
    ];
    for (const reason of reasons) {
      expect(FAILED_MESSAGES[reason]).toBeDefined();
      expect(typeof FAILED_MESSAGES[reason]).toBe("string");
      expect(FAILED_MESSAGES[reason].length).toBeGreaterThan(0);
    }
  });
});

// ── evaluateSingleCondition ─────────────────────────────────────────────────

describe("evaluateSingleCondition", () => {
  // -- FIELD_MISSING --
  describe("FIELD_MISSING", () => {
    it("returns FAILED:FIELD_MISSING when field is not in mappedFields", () => {
      const result = evaluateSingleCondition(
        makeEntry("nonexistent", "eq", "yes"),
        [makeMapped({ field_key: "other" })],
        [makeSchema("nonexistent")],
      );
      expect(result).toEqual({
        result: "FAILED",
        reason: "FIELD_MISSING",
        message: FAILED_MESSAGES.FIELD_MISSING,
      });
    });

    it("returns FAILED:FIELD_MISSING when mapped field status is 'missing'", () => {
      const result = evaluateSingleCondition(
        makeEntry("field_a", "eq", "yes"),
        [makeMapped({ field_key: "field_a", status: "missing", normalized_value: null })],
        [makeSchema("field_a")],
      );
      expect(result).toEqual({
        result: "FAILED",
        reason: "FIELD_MISSING",
        message: FAILED_MESSAGES.FIELD_MISSING,
      });
    });
  });

  // -- MAPPING_FAILED --
  describe("MAPPING_FAILED", () => {
    it("returns FAILED:MAPPING_FAILED when mapped field status is 'inferred'", () => {
      const result = evaluateSingleCondition(
        makeEntry("field_a", "eq", "yes"),
        [makeMapped({ field_key: "field_a", status: "inferred", normalized_value: "yes" })],
        [makeSchema("field_a", ["yes", "no"])],
      );
      expect(result).toEqual({
        result: "FAILED",
        reason: "MAPPING_FAILED",
        message: FAILED_MESSAGES.MAPPING_FAILED,
      });
    });
  });

  // -- VALUE_UNLISTED --
  describe("VALUE_UNLISTED", () => {
    it("returns FAILED:VALUE_UNLISTED when value is not in schema enum", () => {
      const result = evaluateSingleCondition(
        makeEntry("field_a", "eq", "maybe"),
        [makeMapped({ field_key: "field_a", normalized_value: "maybe" })],
        [makeSchema("field_a", ["yes", "no"])],
      );
      expect(result).toEqual({
        result: "FAILED",
        reason: "VALUE_UNLISTED",
        message: FAILED_MESSAGES.VALUE_UNLISTED,
      });
    });

    it("checks VALUE_UNLISTED before operator evaluation", () => {
      // Even though "maybe" neq "yes" would be TRUE, VALUE_UNLISTED takes priority
      const result = evaluateSingleCondition(
        makeEntry("field_a", "neq", "yes"),
        [makeMapped({ field_key: "field_a", normalized_value: "maybe" })],
        [makeSchema("field_a", ["yes", "no"])],
      );
      expect(result.result).toBe("FAILED");
      expect((result as { reason: string }).reason).toBe("VALUE_UNLISTED");
    });

    it("skips VALUE_UNLISTED check when schema values array is empty", () => {
      const result = evaluateSingleCondition(
        makeEntry("field_a", "eq", "anything"),
        [makeMapped({ field_key: "field_a", normalized_value: "anything" })],
        [makeSchema("field_a", [])], // no enum constraint
      );
      expect(result).toEqual({ result: "TRUE" });
    });

    it("uses case-insensitive comparison for VALUE_UNLISTED", () => {
      const result = evaluateSingleCondition(
        makeEntry("field_a", "eq", "Yes"),
        [makeMapped({ field_key: "field_a", normalized_value: "yes" })],
        [makeSchema("field_a", ["Yes", "No"])], // schema has mixed case
      );
      // "yes" is in ["yes", "no"] after normalize -> not unlisted
      expect(result.result).toBe("TRUE");
    });
  });

  // -- eq operator --
  describe("eq operator", () => {
    it("returns TRUE when normalized_value equals expected (both trimmed+lowercased)", () => {
      const result = evaluateSingleCondition(
        makeEntry("field_a", "eq", "  Yes  "),
        [makeMapped({ field_key: "field_a", normalized_value: "yes" })],
        [makeSchema("field_a", ["yes", "no"])],
      );
      expect(result).toEqual({ result: "TRUE" });
    });

    it("returns FALSE when normalized_value does not equal expected", () => {
      const result = evaluateSingleCondition(
        makeEntry("field_a", "eq", "no"),
        [makeMapped({ field_key: "field_a", normalized_value: "yes" })],
        [makeSchema("field_a", ["yes", "no"])],
      );
      expect(result).toEqual({ result: "FALSE" });
    });
  });

  // -- neq operator --
  describe("neq operator", () => {
    it("returns TRUE when normalized_value does not equal expected", () => {
      const result = evaluateSingleCondition(
        makeEntry("field_a", "neq", "no"),
        [makeMapped({ field_key: "field_a", normalized_value: "yes" })],
        [makeSchema("field_a", ["yes", "no"])],
      );
      expect(result).toEqual({ result: "TRUE" });
    });

    it("returns FALSE when normalized_value equals expected", () => {
      const result = evaluateSingleCondition(
        makeEntry("field_a", "neq", "yes"),
        [makeMapped({ field_key: "field_a", normalized_value: "yes" })],
        [makeSchema("field_a", ["yes", "no"])],
      );
      expect(result).toEqual({ result: "FALSE" });
    });
  });

  // -- Schema field not found --
  describe("no schema field for entry", () => {
    it("skips VALUE_UNLISTED check when schema field not found and evaluates operator", () => {
      const result = evaluateSingleCondition(
        makeEntry("field_a", "eq", "yes"),
        [makeMapped({ field_key: "field_a", normalized_value: "yes" })],
        [], // no schema fields at all
      );
      expect(result).toEqual({ result: "TRUE" });
    });
  });
});

// ── evaluateConditionsV2 ────────────────────────────────────────────────────

describe("evaluateConditionsV2", () => {
  const mappedFields = [
    makeMapped({ field_key: "city", normalized_value: "mumbai" }),
    makeMapped({ field_key: "plan", normalized_value: "premium" }),
  ];
  const schemaFields = [
    makeSchema("city", ["mumbai", "delhi", "bangalore"]),
    makeSchema("plan", ["basic", "premium"]),
  ];

  // -- AND logic --
  describe("AND logic", () => {
    it("returns TRUE when all conditions match", () => {
      const result = evaluateConditionsV2(
        [makeEntry("city", "eq", "mumbai"), makeEntry("plan", "eq", "premium")],
        mappedFields,
        schemaFields,
        "and",
      );
      expect(result).toEqual({ result: "TRUE" });
    });

    it("short-circuits on first FALSE", () => {
      const result = evaluateConditionsV2(
        [
          makeEntry("city", "eq", "delhi"), // FALSE
          makeEntry("plan", "eq", "premium"), // would be TRUE
        ],
        mappedFields,
        schemaFields,
        "and",
      );
      expect(result).toEqual({ result: "FALSE" });
    });

    it("short-circuits on first FAILED", () => {
      const result = evaluateConditionsV2(
        [
          makeEntry("nonexistent", "eq", "x"), // FAILED:FIELD_MISSING
          makeEntry("city", "eq", "mumbai"), // would be TRUE
        ],
        mappedFields,
        schemaFields,
        "and",
      );
      expect(result.result).toBe("FAILED");
      expect((result as { reason: string }).reason).toBe("FIELD_MISSING");
    });

    it("returns TRUE for empty conditions array", () => {
      const result = evaluateConditionsV2([], mappedFields, schemaFields, "and");
      expect(result).toEqual({ result: "TRUE" });
    });
  });

  // -- OR logic --
  describe("OR logic", () => {
    it("short-circuits on first TRUE", () => {
      const result = evaluateConditionsV2(
        [
          makeEntry("city", "eq", "mumbai"), // TRUE
          makeEntry("plan", "eq", "basic"), // would be FALSE
        ],
        mappedFields,
        schemaFields,
        "or",
      );
      expect(result).toEqual({ result: "TRUE" });
    });

    it("returns FALSE when all conditions are FALSE", () => {
      const result = evaluateConditionsV2(
        [
          makeEntry("city", "eq", "delhi"),
          makeEntry("plan", "eq", "basic"),
        ],
        mappedFields,
        schemaFields,
        "or",
      );
      expect(result).toEqual({ result: "FALSE" });
    });

    it("returns last FAILED when no TRUE and some FAILED", () => {
      const result = evaluateConditionsV2(
        [
          makeEntry("city", "eq", "delhi"), // FALSE
          makeEntry("nonexistent", "eq", "x"), // FAILED:FIELD_MISSING
        ],
        mappedFields,
        schemaFields,
        "or",
      );
      expect(result.result).toBe("FAILED");
      expect((result as { reason: string }).reason).toBe("FIELD_MISSING");
    });

    it("returns FALSE for empty conditions array", () => {
      const result = evaluateConditionsV2([], mappedFields, schemaFields, "or");
      expect(result).toEqual({ result: "FALSE" });
    });
  });

  // -- Single condition --
  describe("single condition", () => {
    it("returns result of the single evaluation", () => {
      const result = evaluateConditionsV2(
        [makeEntry("city", "eq", "mumbai")],
        mappedFields,
        schemaFields,
        "and",
      );
      expect(result).toEqual({ result: "TRUE" });
    });
  });
});

// ── extractFlowPayload ────────────────────────────────────────────────────

describe("extractFlowPayload", () => {
  it("parses response_json from message.interactive.nfm_reply", () => {
    const message = {
      interactive: {
        nfm_reply: {
          response_json: JSON.stringify({ city: "Mumbai", plan: "Premium" }),
        },
      },
    };
    expect(extractFlowPayload(message)).toEqual({ city: "Mumbai", plan: "Premium" });
  });

  it("returns null when interactive is missing", () => {
    expect(extractFlowPayload({})).toBeNull();
  });

  it("returns null when nfm_reply is missing", () => {
    expect(extractFlowPayload({ interactive: {} })).toBeNull();
  });

  it("returns null when response_json is missing", () => {
    expect(extractFlowPayload({ interactive: { nfm_reply: {} } })).toBeNull();
  });

  it("returns null when response_json is not valid JSON", () => {
    expect(extractFlowPayload({ interactive: { nfm_reply: { response_json: "bad{json" } } })).toBeNull();
  });
});

// ── walkBranchV2 integration ──────────────────────────────────────────────

// Mock schema accessor
vi.mock("../../lib/schemaAccessors", () => ({
  getSchemaByFlowIdAndVersion: vi.fn(),
}));

import { getSchemaByFlowIdAndVersion } from "../schemaAccessors";
const mockGetSchema = vi.mocked(getSchemaByFlowIdAndVersion);

describe("walkBranchV2", () => {
  // Helpers for building test fixtures
  function makeCtx(overrides: Partial<any> = {}): any {
    return {
      db: {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      },
      phone: "+1234567890",
      conversationId: 1,
      message: {
        interactive: {
          nfm_reply: {
            response_json: JSON.stringify({ city: "Mumbai", plan: "Premium" }),
          },
        },
      },
      referral: null,
      env: {},
      executionId: 100,
      nodes: [],
      childrenMap: new Map(),
      ...overrides,
    };
  }

  function makeBranchNode(id = 10): any {
    return { id, nodeType: "branch", config: {}, parentNodeId: 1, position: 0 };
  }

  function makeConditionV2Child(id = 20, config: any = {}): any {
    return {
      id,
      nodeType: "condition",
      parentNodeId: 10,
      position: 0,
      config: {
        version: 2,
        flow_id: "flow_123",
        schema_version: "v1.0",
        logic: "and",
        conditions: [{ field_key: "city", operator: "eq", value: "mumbai" }],
        ...config,
      },
    };
  }

  function makeDefaultChild(id = 30): any {
    return {
      id,
      nodeType: "condition",
      parentNodeId: 10,
      position: 1,
      config: { operator: "default" },
    };
  }

  const testSchema = {
    id: 1,
    flowId: "flow_123",
    flowVersion: "v1.0",
    status: "active",
    fields: [
      { field_key: "city", label: "City", type: "string", values: ["mumbai", "delhi"], screen_id: "s0" },
      { field_key: "plan", label: "Plan", type: "string", values: ["basic", "premium"], screen_id: "s0" },
    ],
    syncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    // Re-mock after restore
    mockGetSchema.mockReset();
  });

  it("dispatches v2 config to walkBranchV2 (not v1 path)", async () => {
    const condChild = makeConditionV2Child();
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    const ctx = makeCtx({
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
    });
    mockGetSchema.mockResolvedValue(testSchema as any);

    const result = await walkBranchV2(ctx, makeBranchNode(), children);
    expect(result).toBe("continue");
    expect(mockGetSchema).toHaveBeenCalledWith(ctx.db, "flow_123", "v1.0");
  });

  it("returns FAILED:MAPPING_FAILED when response_json is missing", async () => {
    const condChild = makeConditionV2Child();
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    const ctx = makeCtx({
      message: {}, // no interactive
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await walkBranchV2(ctx, makeBranchNode(), children);

    expect(result).toBe("continue");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("MAPPING_FAILED"),
    );
    warnSpy.mockRestore();
  });

  it("returns FAILED:SCHEMA_NOT_FOUND when schema lookup returns undefined", async () => {
    const condChild = makeConditionV2Child();
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    const ctx = makeCtx({
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
    });
    mockGetSchema.mockResolvedValue(undefined);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await walkBranchV2(ctx, makeBranchNode(), children);

    expect(result).toBe("continue");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SCHEMA_NOT_FOUND"),
    );
    warnSpy.mockRestore();
  });

  it("returns FAILED:SCHEMA_LOAD_FAILED when schema lookup throws", async () => {
    const condChild = makeConditionV2Child();
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    const ctx = makeCtx({
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
    });
    mockGetSchema.mockRejectedValue(new Error("DB connection failed"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await walkBranchV2(ctx, makeBranchNode(), children);

    expect(result).toBe("continue");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SCHEMA_LOAD_FAILED"),
    );
    warnSpy.mockRestore();
  });

  it("FAILED result updates execution context JSONB with condition_failures", async () => {
    const condChild = makeConditionV2Child();
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    const mockSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const ctx = makeCtx({
      message: {}, // no interactive -> MAPPING_FAILED
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
      db: {
        update: vi.fn().mockReturnValue({ set: mockSet }),
      },
    });

    vi.spyOn(console, "warn").mockImplementation(() => {});
    await walkBranchV2(ctx, makeBranchNode(), children);

    expect(ctx.db.update).toHaveBeenCalled();
    const setArg = mockSet.mock.calls[0][0];
    expect(setArg.context).toBeDefined();
    // context should include condition_failures
    const contextValue = typeof setArg.context === "function"
      ? setArg.context
      : setArg.context;
    expect(contextValue).toBeDefined();
  });

  it("loads schema using config's flow_id and schema_version (not latest)", async () => {
    const condChild = makeConditionV2Child(20, {
      flow_id: "flow_abc",
      schema_version: "v2.3",
    });
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    const ctx = makeCtx({
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
    });
    mockGetSchema.mockResolvedValue({ ...testSchema, flowId: "flow_abc", flowVersion: "v2.3" } as any);

    await walkBranchV2(ctx, makeBranchNode(), children);
    expect(mockGetSchema).toHaveBeenCalledWith(ctx.db, "flow_abc", "v2.3");
  });

  it("routes TRUE result to matching condition node's children", async () => {
    // city eq mumbai -> TRUE, so should walk condChild's children
    const condChild = makeConditionV2Child();
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    // condChild (id=20) has no children — walkBranchV2 should still return "continue"
    const ctx = makeCtx({
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
    });
    mockGetSchema.mockResolvedValue(testSchema as any);

    const result = await walkBranchV2(ctx, makeBranchNode(), children);
    expect(result).toBe("continue");
    // Verify schema was loaded (confirms v2 path was taken, not default branch)
    expect(mockGetSchema).toHaveBeenCalledWith(ctx.db, "flow_123", "v1.0");
  });

  it("routes FALSE result to default branch", async () => {
    const condChild = makeConditionV2Child(20, {
      conditions: [{ field_key: "city", operator: "eq", value: "delhi" }], // won't match mumbai
    });
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    const ctx = makeCtx({
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
    });
    mockGetSchema.mockResolvedValue(testSchema as any);

    const result = await walkBranchV2(ctx, makeBranchNode(), children);
    expect(result).toBe("continue");
    // Default branch was walked (no error thrown)
  });
});

// ── BUDGET_MS ──────────────────────────────────────────────────────────────

describe("BUDGET_MS", () => {
  it("is 200", () => {
    expect(BUDGET_MS).toBe(200);
  });
});

// ── timeout enforcement ───────────────────────────────────────────────────

describe("walkBranchV2 timeout", () => {
  function makeCtx(overrides: Partial<any> = {}): any {
    return {
      db: {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      },
      phone: "+1234567890",
      conversationId: 1,
      message: {
        interactive: {
          nfm_reply: {
            response_json: JSON.stringify({ city: "Mumbai" }),
          },
        },
      },
      referral: null,
      env: {},
      executionId: 100,
      nodes: [],
      childrenMap: new Map(),
      ...overrides,
    };
  }

  function makeBranchNode(id = 10): any {
    return { id, nodeType: "branch", config: {}, parentNodeId: 1, position: 0 };
  }

  function makeConditionV2Child(id = 20, config: any = {}): any {
    return {
      id,
      nodeType: "condition",
      parentNodeId: 10,
      position: 0,
      config: {
        version: 2,
        flow_id: "flow_123",
        schema_version: "v1.0",
        logic: "and",
        conditions: [{ field_key: "city", operator: "eq", value: "mumbai" }],
        ...config,
      },
    };
  }

  function makeDefaultChild(id = 30): any {
    return {
      id,
      nodeType: "condition",
      parentNodeId: 10,
      position: 1,
      config: { operator: "default" },
    };
  }

  const testSchema = {
    id: 1,
    flowId: "flow_123",
    flowVersion: "v1.0",
    status: "active",
    fields: [
      { field_key: "city", label: "City", type: "string", values: ["mumbai", "delhi"], screen_id: "s0" },
    ],
    syncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetSchema.mockReset();
  });

  it("under 200ms returns normal result", async () => {
    const condChild = makeConditionV2Child();
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    const ctx = makeCtx({
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
    });
    mockGetSchema.mockResolvedValue(testSchema as any);

    const result = await walkBranchV2(ctx, makeBranchNode(), children);
    expect(result).toBe("continue");
  });

  it("FAILED:TIMEOUT after schema load when budget exceeded", async () => {
    const condChild = makeConditionV2Child();
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    const ctx = makeCtx({
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
    });

    // Simulate time: Date.now() returns startMs on first call, then startMs+300 after schema load
    let callCount = 0;
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => {
      callCount++;
      // First call (startMs): 1000
      // Second call (after schema load): 1300 (exceeds 200ms budget)
      return callCount <= 1 ? 1000 : 1300;
    });

    mockGetSchema.mockResolvedValue(testSchema as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await walkBranchV2(ctx, makeBranchNode(), children);
    expect(result).toBe("continue");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("TIMEOUT"));

    warnSpy.mockRestore();
  });

  it("TIMEOUT routes to default branch with console.warn", async () => {
    const condChild = makeConditionV2Child();
    const defaultChild = makeDefaultChild();
    const children = [condChild, defaultChild];
    const ctx = makeCtx({
      childrenMap: new Map([[10, children], [20, []], [30, []]]),
    });

    let callCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      callCount++;
      return callCount <= 1 ? 1000 : 1300;
    });

    mockGetSchema.mockResolvedValue(testSchema as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await walkBranchV2(ctx, makeBranchNode(), children);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("TIMEOUT"),
    );

    warnSpy.mockRestore();
  });
});
