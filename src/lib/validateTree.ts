/**
 * Pure tree validation and schema version stamping functions.
 *
 * These operate on a minimal TreeNode interface and do not import
 * from React component files.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface TreeNode {
  tempId: string;
  nodeType: string;
  config: Record<string, unknown>;
  children: TreeNode[];
}

export interface FlowFieldEntry {
  field_key: string;
  label: string;
  type: string;
  values: string[];
  screen_id: string;
}

export interface ValidationErrors {
  nodeErrors: Map<string, string[]>;
  isValid: boolean;
}

interface ConditionEntry {
  field_key: string;
  operator: string;
  value: string;
}

// ── validateTree ─────────────────────────────────────────────────────────────

/**
 * Walk the tree recursively and validate all v2 condition nodes against
 * the provided schema fields.
 *
 * Rules implemented:
 *   VAL-01  v2 node with no schema loaded -> blocking error
 *   VAL-02  field_key not in schema
 *   VAL-03  value not in field's values array
 *   VAL-04  empty conditions array
 *   VAL-05  flat walk (conditions is always an array)
 *   VAL-06  (see stampSchemaVersion)
 */
export function validateTree(
  tree: TreeNode,
  schemaFields: FlowFieldEntry[],
  _flowVersion: string | null,
): ValidationErrors {
  const nodeErrors = new Map<string, string[]>();

  function walk(node: TreeNode): void {
    if (node.nodeType === "condition") {
      const config = node.config;
      const version = config.version;

      // Only validate v2 condition nodes
      if (version === 2) {
        const errors: string[] = [];

        // VAL-01: schema existence check (must come first)
        if (schemaFields.length === 0) {
          errors.push("Load response options before saving");
        } else {
          // VAL-04: at least one complete condition
          const conditions = (config.conditions ?? []) as ConditionEntry[];
          const hasComplete = conditions.some(
            (c) => c.field_key && c.value,
          );
          if (!hasComplete) {
            errors.push("Add at least one complete condition");
          }

          // VAL-02 / VAL-03: per-field checks (only when schema IS loaded)
          for (const cond of conditions) {
            if (!cond.field_key || !cond.value) continue;

            const field = schemaFields.find(
              (f) => f.field_key === cond.field_key,
            );
            if (!field) {
              errors.push(
                `Field "${cond.field_key}" not found in response options`,
              );
              continue;
            }
            if (!field.values.includes(cond.value)) {
              errors.push(
                `Value "${cond.value}" is not a valid option for "${cond.field_key}"`,
              );
            }
          }
        }

        if (errors.length > 0) {
          nodeErrors.set(node.tempId, errors);
        }
      }
      // v1 condition nodes: skip all validation
    }

    // Recurse into children
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree);

  return {
    nodeErrors,
    isValid: nodeErrors.size === 0,
  };
}

// ── stampSchemaVersion ───────────────────────────────────────────────────────

/**
 * Clone tree and stamp flowVersion onto all v2 condition nodes' config.schema_version.
 * Returns a new tree (does not mutate input). VAL-06.
 */
export function stampSchemaVersion(
  tree: TreeNode,
  flowVersion: string | null,
): TreeNode {
  function cloneAndStamp(node: TreeNode): TreeNode {
    const clonedConfig = { ...node.config };

    if (
      node.nodeType === "condition" &&
      clonedConfig.version === 2 &&
      flowVersion !== null
    ) {
      clonedConfig.schema_version = flowVersion;
    }

    return {
      ...node,
      config: clonedConfig,
      children: node.children.map(cloneAndStamp),
    };
  }

  return cloneAndStamp(tree);
}
