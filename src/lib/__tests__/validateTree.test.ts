import { describe, it, expect } from "vitest";
import { validateTree, stampSchemaVersion } from "../validateTree";
import type { TreeNode } from "../validateTree";
import type { FlowFieldEntry } from "../validateTree";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConditionNode(
  overrides: Partial<TreeNode> & { config: Record<string, unknown> }
): TreeNode {
  return {
    tempId: overrides.tempId ?? "cond-1",
    nodeType: "condition",
    config: overrides.config,
    children: overrides.children ?? [],
  };
}

const SCHEMA_FIELDS: FlowFieldEntry[] = [
  {
    field_key: "interest",
    label: "Interest",
    type: "string",
    values: ["buy", "rent", "invest"],
    screen_id: "screen_1",
  },
  {
    field_key: "budget",
    label: "Budget",
    type: "string",
    values: ["low", "medium", "high"],
    screen_id: "screen_1",
  },
];

// ── validateTree ─────────────────────────────────────────────────────────────

describe("validateTree", () => {
  it("returns isValid=true for valid v2 conditions matching schema", () => {
    const tree: TreeNode = {
      tempId: "root",
      nodeType: "trigger",
      config: {},
      children: [
        makeConditionNode({
          config: {
            version: 2,
            schema_version: "5.0",
            flow_id: "flow_1",
            logic: "and",
            conditions: [{ field_key: "interest", operator: "eq", value: "buy" }],
          },
        }),
      ],
    };
    const result = validateTree(tree, SCHEMA_FIELDS, "5.0");
    expect(result.isValid).toBe(true);
    expect(result.nodeErrors.size).toBe(0);
  });

  it("returns error for empty conditions array (VAL-04)", () => {
    const tree = makeConditionNode({
      config: {
        version: 2,
        schema_version: "5.0",
        flow_id: "flow_1",
        logic: "and",
        conditions: [],
      },
    });
    const result = validateTree(tree, SCHEMA_FIELDS, "5.0");
    expect(result.isValid).toBe(false);
    const errors = result.nodeErrors.get("cond-1");
    expect(errors).toBeDefined();
    expect(errors!.some((e) => e.includes("at least one"))).toBe(true);
  });

  it("returns error when field_key not found in schema (VAL-02)", () => {
    const tree = makeConditionNode({
      config: {
        version: 2,
        schema_version: "5.0",
        flow_id: "flow_1",
        logic: "and",
        conditions: [{ field_key: "nonexistent", operator: "eq", value: "x" }],
      },
    });
    const result = validateTree(tree, SCHEMA_FIELDS, "5.0");
    expect(result.isValid).toBe(false);
    const errors = result.nodeErrors.get("cond-1");
    expect(errors).toBeDefined();
    expect(errors!.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  it("returns error when value not in field values array (VAL-03)", () => {
    const tree = makeConditionNode({
      config: {
        version: 2,
        schema_version: "5.0",
        flow_id: "flow_1",
        logic: "and",
        conditions: [{ field_key: "interest", operator: "eq", value: "unknown_val" }],
      },
    });
    const result = validateTree(tree, SCHEMA_FIELDS, "5.0");
    expect(result.isValid).toBe(false);
    const errors = result.nodeErrors.get("cond-1");
    expect(errors).toBeDefined();
    expect(errors!.some((e) => e.includes("unknown_val"))).toBe(true);
  });

  it("returns isValid=true for v1 conditions (skip v2 validation)", () => {
    const tree = makeConditionNode({
      config: {
        version: 1,
        conditions: [{ field_key: "anything", operator: "eq", value: "whatever" }],
      },
    });
    const result = validateTree(tree, SCHEMA_FIELDS, "5.0");
    expect(result.isValid).toBe(true);
  });

  it("v1 condition node with empty schemaFields -> isValid=true", () => {
    const tree = makeConditionNode({
      config: {
        version: 1,
        conditions: [{ field_key: "x", operator: "eq", value: "y" }],
      },
    });
    const result = validateTree(tree, [], "5.0");
    expect(result.isValid).toBe(true);
  });

  it("v2 condition node with empty schemaFields -> isValid=false, VAL-01 error", () => {
    const tree = makeConditionNode({
      config: {
        version: 2,
        schema_version: "5.0",
        flow_id: "flow_1",
        logic: "and",
        conditions: [{ field_key: "interest", operator: "eq", value: "buy" }],
      },
    });
    const result = validateTree(tree, [], "5.0");
    expect(result.isValid).toBe(false);
    const errors = result.nodeErrors.get("cond-1");
    expect(errors).toBeDefined();
    expect(errors!.some((e) => e.includes("Load response options before saving"))).toBe(true);
  });

  it("returns errors keyed by node tempId", () => {
    const tree: TreeNode = {
      tempId: "root",
      nodeType: "trigger",
      config: {},
      children: [
        makeConditionNode({
          tempId: "node-abc",
          config: {
            version: 2,
            schema_version: "5.0",
            flow_id: "flow_1",
            logic: "and",
            conditions: [],
          },
        }),
      ],
    };
    const result = validateTree(tree, SCHEMA_FIELDS, "5.0");
    expect(result.nodeErrors.has("node-abc")).toBe(true);
    expect(result.nodeErrors.has("root")).toBe(false);
  });

  it("walks nested tree and validates all condition nodes at every depth (VAL-05)", () => {
    const tree: TreeNode = {
      tempId: "root",
      nodeType: "trigger",
      config: {},
      children: [
        {
          tempId: "branch-1",
          nodeType: "branch",
          config: {},
          children: [
            makeConditionNode({
              tempId: "deep-cond",
              config: {
                version: 2,
                schema_version: "5.0",
                flow_id: "flow_1",
                logic: "and",
                conditions: [{ field_key: "nonexistent", operator: "eq", value: "x" }],
              },
            }),
          ],
        },
      ],
    };
    const result = validateTree(tree, SCHEMA_FIELDS, "5.0");
    expect(result.isValid).toBe(false);
    expect(result.nodeErrors.has("deep-cond")).toBe(true);
  });

  it("returns isValid=true for non-condition node types", () => {
    const tree: TreeNode = {
      tempId: "root",
      nodeType: "trigger",
      config: {},
      children: [
        { tempId: "act-1", nodeType: "action", config: {}, children: [] },
        { tempId: "br-1", nodeType: "branch", config: {}, children: [] },
      ],
    };
    const result = validateTree(tree, SCHEMA_FIELDS, "5.0");
    expect(result.isValid).toBe(true);
  });
});

// ── stampSchemaVersion ───────────────────────────────────────────────────────

describe("stampSchemaVersion", () => {
  it("stamps flowVersion onto all v2 condition nodes", () => {
    const tree: TreeNode = {
      tempId: "root",
      nodeType: "trigger",
      config: {},
      children: [
        makeConditionNode({
          config: {
            version: 2,
            schema_version: "old",
            flow_id: "f1",
            logic: "and",
            conditions: [],
          },
        }),
      ],
    };
    const stamped = stampSchemaVersion(tree, "6.0");
    expect((stamped.children[0].config as any).schema_version).toBe("6.0");
  });

  it("does not modify v1 condition nodes", () => {
    const tree = makeConditionNode({
      config: { version: 1, conditions: [] },
    });
    const stamped = stampSchemaVersion(tree, "6.0");
    expect((stamped.config as any).schema_version).toBeUndefined();
  });

  it("returns unchanged tree when flowVersion is null", () => {
    const tree = makeConditionNode({
      config: { version: 2, schema_version: "old", conditions: [] },
    });
    const stamped = stampSchemaVersion(tree, null);
    expect((stamped.config as any).schema_version).toBe("old");
  });

  it("returns a new tree object (does not mutate input)", () => {
    const tree = makeConditionNode({
      config: { version: 2, schema_version: "old", conditions: [] },
    });
    const stamped = stampSchemaVersion(tree, "6.0");
    expect(stamped).not.toBe(tree);
    expect((tree.config as any).schema_version).toBe("old");
  });
});
