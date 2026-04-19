/**
 * Template CTA detection — identifies WhatsApp templates that link to Flows.
 *
 * Parses Meta template component arrays to find FLOW-type buttons and
 * extract their flow_id.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface TemplateButton {
  type: string;
  text?: string;
  flow_id?: string;
  flowId?: string;
  url?: string;
  phone_number?: string;
  [key: string]: unknown;
}

export interface TemplateComponent {
  type: string;
  format?: string;
  buttons?: TemplateButton[];
  [key: string]: unknown;
}

// ── extractFlowIdFromTemplate ───────────────────────────────────────────────

/**
 * Finds a FLOW-type button in a template's components and returns its flow_id.
 * Returns null if no FLOW button is found.
 *
 * Handles both `flow_id` and `flowId` field names, and case-insensitive
 * "FLOW" / "flow" type matching.
 */
export function extractFlowIdFromTemplate(
  components: TemplateComponent[],
): string | null {
  const buttonsComp = components.find((c) => c.type === "BUTTONS");
  if (!buttonsComp?.buttons) return null;

  const flowButton = buttonsComp.buttons.find(
    (b) => b.type.toLowerCase() === "flow",
  );
  if (!flowButton) return null;

  return flowButton.flow_id ?? flowButton.flowId ?? null;
}

// ── enrichTemplatesWithFlowInfo ─────────────────────────────────────────────

/**
 * Enriches an array of templates by adding a `flow_id` property to each.
 * Templates without a FLOW CTA get `flow_id: null`.
 */
export function enrichTemplatesWithFlowInfo<
  T extends { components?: TemplateComponent[] },
>(templates: T[]): Array<T & { flow_id: string | null }> {
  return templates.map((template) => ({
    ...template,
    flow_id: template.components
      ? extractFlowIdFromTemplate(template.components)
      : null,
  }));
}
