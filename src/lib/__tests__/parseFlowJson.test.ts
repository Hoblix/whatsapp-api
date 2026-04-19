import { describe, it, expect } from "vitest";
import {
  extractEnumFields,
  mergeFieldValues,
  type FlowJsonDefinition,
  type FlowComponent,
} from "../parseFlowJson";

// ── extractEnumFields ───────────────────────────────────────────────────────

describe("extractEnumFields", () => {
  it("parses a single Dropdown from one screen into FlowFieldEntry", () => {
    const flowJson: FlowJsonDefinition = {
      version: "3.0",
      screens: [
        {
          id: "SCREEN_ONE",
          title: "Choose City",
          layout: {
            type: "SingleColumnLayout",
            children: [
              {
                type: "Dropdown",
                name: "city",
                label: "Select City",
                options: [
                  { option_name: "Mumbai", option_value: "mumbai" },
                  { option_name: "Delhi", option_value: "delhi" },
                ],
              },
            ],
          },
        },
      ],
    };

    const fields = extractEnumFields(flowJson);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      field_key: "city",
      label: "Select City",
      type: "enum",
      values: ["mumbai", "delhi"],
      screen_id: "SCREEN_ONE",
    });
  });

  it("parses RadioButtonsGroup the same way", () => {
    const flowJson: FlowJsonDefinition = {
      version: "3.0",
      screens: [
        {
          id: "SCREEN_RADIO",
          title: "Pick Plan",
          layout: {
            type: "SingleColumnLayout",
            children: [
              {
                type: "RadioButtonsGroup",
                name: "plan",
                label: "Choose Plan",
                options: [
                  { option_name: "Basic", option_value: "basic" },
                  { option_name: "Pro", option_value: "pro" },
                ],
              },
            ],
          },
        },
      ],
    };

    const fields = extractEnumFields(flowJson);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      field_key: "plan",
      label: "Choose Plan",
      type: "enum",
      values: ["basic", "pro"],
      screen_id: "SCREEN_RADIO",
    });
  });

  it("extracts fields from ALL screens (not just first/last)", () => {
    const flowJson: FlowJsonDefinition = {
      version: "3.0",
      screens: [
        {
          id: "S1",
          title: "Step 1",
          layout: {
            type: "SingleColumnLayout",
            children: [
              {
                type: "Dropdown",
                name: "field_a",
                label: "Field A",
                options: [{ option_name: "A1", option_value: "a1" }],
              },
            ],
          },
        },
        {
          id: "S2",
          title: "Step 2",
          layout: {
            type: "SingleColumnLayout",
            children: [
              {
                type: "Dropdown",
                name: "field_b",
                label: "Field B",
                options: [{ option_name: "B1", option_value: "b1" }],
              },
            ],
          },
        },
        {
          id: "S3",
          title: "Step 3",
          layout: {
            type: "SingleColumnLayout",
            children: [
              {
                type: "RadioButtonsGroup",
                name: "field_c",
                label: "Field C",
                options: [{ option_name: "C1", option_value: "c1" }],
              },
            ],
          },
        },
      ],
    };

    const fields = extractEnumFields(flowJson);
    expect(fields).toHaveLength(3);
    expect(fields.map((f) => f.field_key)).toEqual(["field_a", "field_b", "field_c"]);
    expect(fields.map((f) => f.screen_id)).toEqual(["S1", "S2", "S3"]);
  });

  it("ignores non-enum components (TextInput, DatePicker, TextHeading, etc.)", () => {
    const flowJson: FlowJsonDefinition = {
      version: "3.0",
      screens: [
        {
          id: "S1",
          title: "Form",
          layout: {
            type: "SingleColumnLayout",
            children: [
              { type: "TextInput", name: "name", label: "Name" },
              { type: "DatePicker", name: "dob", label: "Date of Birth" },
              { type: "TextHeading", name: "heading" },
              {
                type: "Dropdown",
                name: "city",
                label: "City",
                options: [{ option_name: "Delhi", option_value: "delhi" }],
              },
            ],
          },
        },
      ],
    };

    const fields = extractEnumFields(flowJson);
    expect(fields).toHaveLength(1);
    expect(fields[0].field_key).toBe("city");
  });

  it("recursively walks nested children (e.g., Dropdown inside Form inside SingleColumnLayout)", () => {
    const flowJson: FlowJsonDefinition = {
      version: "3.0",
      screens: [
        {
          id: "S1",
          title: "Nested Form",
          layout: {
            type: "SingleColumnLayout",
            children: [
              {
                type: "Form",
                name: "form",
                children: [
                  {
                    type: "Container",
                    name: "container",
                    children: [
                      {
                        type: "Dropdown",
                        name: "deep_field",
                        label: "Deep Field",
                        options: [
                          { option_name: "X", option_value: "x" },
                          { option_name: "Y", option_value: "y" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    const fields = extractEnumFields(flowJson);
    expect(fields).toHaveLength(1);
    expect(fields[0].field_key).toBe("deep_field");
    expect(fields[0].values).toEqual(["x", "y"]);
  });

  it("handles empty screens array (returns [])", () => {
    const flowJson: FlowJsonDefinition = {
      version: "3.0",
      screens: [],
    };

    const fields = extractEnumFields(flowJson);
    expect(fields).toEqual([]);
  });

  it("uses component name as label fallback when label is missing", () => {
    const flowJson: FlowJsonDefinition = {
      version: "3.0",
      screens: [
        {
          id: "S1",
          title: "No Label",
          layout: {
            type: "SingleColumnLayout",
            children: [
              {
                type: "Dropdown",
                name: "no_label_field",
                options: [{ option_name: "V1", option_value: "v1" }],
              },
            ],
          },
        },
      ],
    };

    const fields = extractEnumFields(flowJson);
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe("no_label_field");
  });
});

// ── mergeFieldValues ────────────────────────────────────────────────────────

describe("mergeFieldValues", () => {
  const baseFields = [
    { field_key: "city", label: "City", type: "enum", values: ["mumbai", "delhi"], screen_id: "S1" },
    { field_key: "plan", label: "Plan", type: "enum", values: ["basic"], screen_id: "S2" },
  ];

  it("Meta values come first, DB values supplement (added after Meta values)", () => {
    const dbRules = [{ fieldKey: "city", value: "bangalore" }];
    const merged = mergeFieldValues(baseFields, dbRules);

    const cityField = merged.find((f) => f.field_key === "city")!;
    expect(cityField.values).toEqual(["mumbai", "delhi", "bangalore"]);
  });

  it("duplicate values from DB are not added (dedup)", () => {
    const dbRules = [
      { fieldKey: "city", value: "mumbai" },
      { fieldKey: "city", value: "bangalore" },
    ];
    const merged = mergeFieldValues(baseFields, dbRules);

    const cityField = merged.find((f) => f.field_key === "city")!;
    expect(cityField.values).toEqual(["mumbai", "delhi", "bangalore"]);
  });

  it("fields with no DB match are returned unchanged", () => {
    const dbRules = [{ fieldKey: "nonexistent", value: "something" }];
    const merged = mergeFieldValues(baseFields, dbRules);

    expect(merged).toEqual(baseFields);
  });

  it("DB values for unknown field_keys are ignored (no phantom fields created)", () => {
    const dbRules = [
      { fieldKey: "phantom", value: "ghost" },
      { fieldKey: "city", value: "pune" },
    ];
    const merged = mergeFieldValues(baseFields, dbRules);

    expect(merged).toHaveLength(2);
    expect(merged.find((f) => f.field_key === "phantom")).toBeUndefined();
    const cityField = merged.find((f) => f.field_key === "city")!;
    expect(cityField.values).toEqual(["mumbai", "delhi", "pune"]);
  });
});
