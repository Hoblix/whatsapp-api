/**
 * Flow JSON parsing and field value merging.
 *
 * Parses WhatsApp Flow JSON definitions to extract enum fields (Dropdown,
 * RadioButtonsGroup) and merges them with DB routing rule values.
 */

import type { FlowFieldEntry } from "./schema/flow-field-schemas";

// ── Types ───────────────────────────────────────────────────────────────────

export interface FlowComponent {
  type: string;
  name?: string;
  label?: string;
  children?: FlowComponent[];
  options?: Array<{ option_name: string; option_value: string }>;
}

export interface FlowJsonDefinition {
  version: string;
  screens: Array<{
    id: string;
    title: string;
    layout: {
      type: string;
      children: FlowComponent[];
    };
  }>;
}

// ── Enum component types we extract ─────────────────────────────────────────

const ENUM_TYPES = new Set(["Dropdown", "RadioButtonsGroup"]);

// ── extractEnumFields ───────────────────────────────────────────────────────

/**
 * Recursively walks a Flow JSON definition and extracts all Dropdown and
 * RadioButtonsGroup components as FlowFieldEntry records.
 */
export function extractEnumFields(flowJson: FlowJsonDefinition): FlowFieldEntry[] {
  const results: FlowFieldEntry[] = [];

  for (const screen of flowJson.screens) {
    walkComponents(screen.layout.children, screen.id, results);
  }

  return results;
}

function walkComponents(
  components: FlowComponent[],
  screenId: string,
  results: FlowFieldEntry[],
): void {
  for (const comp of components) {
    if (ENUM_TYPES.has(comp.type) && comp.options && comp.name) {
      results.push({
        field_key: comp.name,
        label: comp.label ?? comp.name,
        type: "enum",
        values: comp.options.map((o) => o.option_value),
        screen_id: screenId,
      });
    }

    // Recurse into nested children
    if (comp.children) {
      walkComponents(comp.children, screenId, results);
    }
  }
}

// ── mergeFieldValues ────────────────────────────────────────────────────────

/**
 * Merges Meta-parsed enum fields with DB routing rule values.
 *
 * - Meta values take priority (appear first).
 * - DB values are appended if not already present (deduplication).
 * - DB values for unknown field_keys are ignored (no phantom fields).
 */
export function mergeFieldValues(
  metaFields: FlowFieldEntry[],
  dbRoutingRules: Array<{ fieldKey: string; value: string }>,
): FlowFieldEntry[] {
  // Group DB rules by fieldKey
  const dbByKey = new Map<string, string[]>();
  for (const rule of dbRoutingRules) {
    if (!dbByKey.has(rule.fieldKey)) {
      dbByKey.set(rule.fieldKey, []);
    }
    dbByKey.get(rule.fieldKey)!.push(rule.value);
  }

  return metaFields.map((field) => {
    const dbValues = dbByKey.get(field.field_key);
    if (!dbValues) return field;

    // Append DB values not already in meta values
    const existingSet = new Set(field.values);
    const newValues = dbValues.filter((v) => !existingSet.has(v));

    if (newValues.length === 0) return field;

    return {
      ...field,
      values: [...field.values, ...newValues],
    };
  });
}

// ── fetchFlowJson ───────────────────────────────────────────────────────────

/**
 * Fetches a Flow JSON definition from the Meta Graph API.
 *
 * Strategy:
 * 1. Try `GET /{flow_id}?fields=json` — if response has a `json` field, use it.
 * 2. Fallback: `GET /{flow_id}/assets` to find FLOW_JSON asset, then download.
 */
export async function fetchFlowJson(
  flowId: string,
  accessToken: string,
  apiVersion: string,
): Promise<FlowJsonDefinition> {
  const baseUrl = `https://graph.facebook.com/${apiVersion}`;

  // Step 1: Try direct json field
  try {
    const directRes = await fetch(
      `${baseUrl}/${flowId}?fields=json&access_token=${accessToken}`,
    );

    if (directRes.ok) {
      const directData = (await directRes.json()) as Record<string, unknown>;

      if (directData.json) {
        // json field may be a string or already-parsed object
        const parsed =
          typeof directData.json === "string"
            ? JSON.parse(directData.json)
            : directData.json;
        return parsed as FlowJsonDefinition;
      }
    }
    // If not ok or no json field, fall through to assets endpoint
  } catch {
    // Fall through to assets endpoint
  }

  // Step 2: Fallback — fetch assets list
  const assetsRes = await fetch(
    `${baseUrl}/${flowId}/assets?access_token=${accessToken}`,
  );

  if (!assetsRes.ok) {
    const errBody = await assetsRes.text();
    throw new Error(
      `Meta API error fetching flow assets for ${flowId}: ${assetsRes.status} ${errBody}`,
    );
  }

  const assetsData = (await assetsRes.json()) as {
    data?: Array<{ asset_type: string; download_url: string }>;
  };

  const flowAsset = assetsData.data?.find(
    (a) => a.asset_type === "FLOW_JSON",
  );

  if (!flowAsset?.download_url) {
    throw new Error(
      `No FLOW_JSON asset found for flow ${flowId}. Assets: ${JSON.stringify(assetsData.data?.map((a) => a.asset_type) ?? [])}`,
    );
  }

  // Step 3: Download the asset
  const downloadRes = await fetch(flowAsset.download_url);

  if (!downloadRes.ok) {
    throw new Error(
      `Failed to download FLOW_JSON asset for flow ${flowId}: ${downloadRes.status}`,
    );
  }

  return (await downloadRes.json()) as FlowJsonDefinition;
}
