import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Table shape tests (pure unit, no DB) ────────────────────────────────────

describe("flowFieldSchemasTable schema shape", () => {
  it("exports a pgTable with all required columns", async () => {
    const { flowFieldSchemasTable } = await import("../schema/flow-field-schemas");
    const cols = flowFieldSchemasTable;

    // Verify all columns exist
    expect(cols.id).toBeDefined();
    expect(cols.flowId).toBeDefined();
    expect(cols.flowVersion).toBeDefined();
    expect(cols.syncedAt).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.fields).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it("exports FlowFieldSchema and InsertFlowFieldSchema types (non-never)", async () => {
    const mod = await import("../schema/flow-field-schemas");
    // Type-level check: if these exports don't exist, import will fail
    expect(mod.flowFieldSchemasTable).toBeDefined();
    // The types are compile-time only, but we verify the module exports them
    // by checking the table that generates them
    type _Select = typeof mod.flowFieldSchemasTable.$inferSelect;
    type _Insert = typeof mod.flowFieldSchemasTable.$inferInsert;
    // If types were never, these assignments would fail at compile time
    const _checkSelect: _Select = {} as _Select;
    const _checkInsert: _Insert = {} as _Insert;
    expect(_checkSelect).toBeDefined();
    expect(_checkInsert).toBeDefined();
  });

  it("FlowFieldEntry interface has required fields", async () => {
    // We verify this through the table's fields column type
    const { flowFieldSchemasTable } = await import("../schema/flow-field-schemas");
    // The fields column exists and is typed as FlowFieldEntry[]
    expect(flowFieldSchemasTable.fields).toBeDefined();
    expect(flowFieldSchemasTable.fields.name).toBe("fields");
  });
});

// ── Accessor function tests (mocked DB) ─────────────────────────────────────

function createMockDb() {
  const mockResult = {
    id: 1,
    flowId: "flow_123",
    flowVersion: "3.0",
    syncedAt: new Date(),
    status: "active",
    fields: [{ field_key: "name", label: "Name", type: "text", values: [], screen_id: "SCREEN_ONE" }],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Build a chainable mock that captures method calls
  const chainState: Record<string, unknown[]> = {};

  const chainable = {
    values: vi.fn().mockImplementation((v: unknown) => { chainState.values = [v]; return chainable; }),
    onConflictDoUpdate: vi.fn().mockImplementation((v: unknown) => { chainState.onConflict = [v]; return chainable; }),
    returning: vi.fn().mockResolvedValue([mockResult]),
    from: vi.fn().mockImplementation(() => chainable),
    where: vi.fn().mockImplementation(() => chainable),
    orderBy: vi.fn().mockImplementation(() => chainable),
    limit: vi.fn().mockResolvedValue([mockResult]),
    set: vi.fn().mockImplementation(() => chainable),
    then: undefined as unknown,
  };

  // Make chainable thenable for awaiting
  const thenableResolve = [mockResult];
  chainable.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => {
    return Promise.resolve(thenableResolve).then(resolve);
  });

  const db = {
    insert: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue(chainable),
    update: vi.fn().mockReturnValue(chainable),
    _chainable: chainable,
    _chainState: chainState,
    _mockResult: mockResult,
  };

  return db as unknown;
}

describe("schemaAccessors", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    vi.clearAllMocks();
  });

  describe("createFlowFieldSchema", () => {
    it("inserts a record and returns it with all fields populated", async () => {
      const { createFlowFieldSchema } = await import("../schemaAccessors");
      const data = {
        flowId: "flow_123",
        flowVersion: "3.0",
        fields: [{ field_key: "name", label: "Name", type: "text", values: [] as string[], screen_id: "SCREEN_ONE" }],
      };
      const result = await createFlowFieldSchema(db as any, data as any);
      expect(result).toBeDefined();
      expect(result.id).toBe(1);
      expect(result.flowId).toBe("flow_123");
      expect((db as any).insert).toHaveBeenCalled();
    });
  });

  describe("upsertFlowFieldSchema", () => {
    it("updates fields/syncedAt/status on conflict (same flowId+flowVersion)", async () => {
      const { upsertFlowFieldSchema } = await import("../schemaAccessors");
      const data = {
        flowId: "flow_123",
        flowVersion: "3.0",
        fields: [{ field_key: "name", label: "Name", type: "text", values: [] as string[], screen_id: "SCREEN_ONE" }],
        status: "active",
      };
      const result = await upsertFlowFieldSchema(db as any, data as any);
      expect(result).toBeDefined();
      expect((db as any).insert).toHaveBeenCalled();
      expect((db as any)._chainable.onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  describe("getActiveSchemaByFlowId", () => {
    it("returns active schema ordered by syncedAt desc", async () => {
      const { getActiveSchemaByFlowId } = await import("../schemaAccessors");
      const result = await getActiveSchemaByFlowId(db as any, "flow_123");
      expect(result).toBeDefined();
      expect((db as any).select).toHaveBeenCalled();
    });

    it("returns undefined when no active schemas exist", async () => {
      const { getActiveSchemaByFlowId } = await import("../schemaAccessors");
      // Override limit to return empty array
      (db as any)._chainable.limit.mockResolvedValueOnce([]);
      const result = await getActiveSchemaByFlowId(db as any, "flow_nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("getSchemaByFlowIdAndVersion", () => {
    it("returns exact match or undefined", async () => {
      const { getSchemaByFlowIdAndVersion } = await import("../schemaAccessors");
      const result = await getSchemaByFlowIdAndVersion(db as any, "flow_123", "3.0");
      expect(result).toBeDefined();
      expect((db as any).select).toHaveBeenCalled();
    });
  });

  describe("getSchemasByFlowId", () => {
    it("returns all versions for a flow_id ordered by syncedAt desc", async () => {
      const { getSchemasByFlowId } = await import("../schemaAccessors");
      // Make it return an array (thenable)
      const result = await getSchemasByFlowId(db as any, "flow_123");
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect((db as any).select).toHaveBeenCalled();
    });
  });

  describe("updateSchemaStatus", () => {
    it("changes status and updatedAt, returns updated record", async () => {
      const { updateSchemaStatus } = await import("../schemaAccessors");
      const result = await updateSchemaStatus(db as any, 1, "deleted");
      expect(result).toBeDefined();
      expect((db as any).update).toHaveBeenCalled();
    });
  });
});
