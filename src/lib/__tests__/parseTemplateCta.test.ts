import { describe, it, expect } from "vitest";
import {
  extractFlowIdFromTemplate,
  enrichTemplatesWithFlowInfo,
  type TemplateComponent,
} from "../parseTemplateCta";

// ── extractFlowIdFromTemplate ───────────────────────────────────────────────

describe("extractFlowIdFromTemplate", () => {
  it("detects FLOW button in BUTTONS component, returns flow_id", () => {
    const components: TemplateComponent[] = [
      { type: "HEADER", format: "TEXT" },
      { type: "BODY" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "FLOW", text: "Start Flow", flow_id: "123456789" },
        ],
      },
    ];

    expect(extractFlowIdFromTemplate(components)).toBe("123456789");
  });

  it("handles camelCase flowId field name", () => {
    const components: TemplateComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          { type: "FLOW", text: "Start Flow", flowId: "987654321" },
        ],
      },
    ];

    expect(extractFlowIdFromTemplate(components)).toBe("987654321");
  });

  it("returns null for templates with no BUTTONS component", () => {
    const components: TemplateComponent[] = [
      { type: "HEADER", format: "TEXT" },
      { type: "BODY" },
      { type: "FOOTER" },
    ];

    expect(extractFlowIdFromTemplate(components)).toBeNull();
  });

  it("returns null for BUTTONS with only URL/PHONE_NUMBER types", () => {
    const components: TemplateComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Visit", url: "https://example.com" },
          { type: "PHONE_NUMBER", text: "Call", phone_number: "+1234567890" },
        ],
      },
    ];

    expect(extractFlowIdFromTemplate(components)).toBeNull();
  });

  it("handles case-insensitive 'flow' type check", () => {
    const components: TemplateComponent[] = [
      {
        type: "BUTTONS",
        buttons: [
          { type: "flow", text: "Start Flow", flow_id: "111222333" },
        ],
      },
    ];

    expect(extractFlowIdFromTemplate(components)).toBe("111222333");
  });
});

// ── enrichTemplatesWithFlowInfo ─────────────────────────────────────────────

describe("enrichTemplatesWithFlowInfo", () => {
  it("adds flow_id to each template in array", () => {
    const templates = [
      {
        name: "flow_template",
        components: [
          {
            type: "BUTTONS" as const,
            buttons: [
              { type: "FLOW", text: "Go", flow_id: "flow_abc" },
            ],
          },
        ],
      },
      {
        name: "url_template",
        components: [
          {
            type: "BUTTONS" as const,
            buttons: [
              { type: "URL", text: "Visit", url: "https://example.com" },
            ],
          },
        ],
      },
    ];

    const enriched = enrichTemplatesWithFlowInfo(templates);
    expect(enriched).toHaveLength(2);
    expect(enriched[0].flow_id).toBe("flow_abc");
    expect(enriched[0].name).toBe("flow_template");
  });

  it("sets flow_id to null for non-flow templates", () => {
    const templates = [
      {
        name: "plain_template",
        components: [{ type: "BODY" as const }],
      },
    ];

    const enriched = enrichTemplatesWithFlowInfo(templates);
    expect(enriched[0].flow_id).toBeNull();
  });
});
