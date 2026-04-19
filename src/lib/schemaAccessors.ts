import { eq, and, desc } from "drizzle-orm";
import type { Database } from "./db";
import {
  flowFieldSchemasTable,
  type FlowFieldSchema,
  type InsertFlowFieldSchema,
} from "./schema";

/**
 * Insert a new flow field schema record.
 */
export async function createFlowFieldSchema(
  db: Database,
  data: InsertFlowFieldSchema,
): Promise<FlowFieldSchema> {
  const [row] = await db
    .insert(flowFieldSchemasTable)
    .values(data)
    .returning();
  return row;
}

/**
 * Insert or update a flow field schema.
 * On conflict (same flow_id + flow_version), updates fields, syncedAt, status, and updatedAt.
 */
export async function upsertFlowFieldSchema(
  db: Database,
  data: InsertFlowFieldSchema,
): Promise<FlowFieldSchema> {
  const [row] = await db
    .insert(flowFieldSchemasTable)
    .values(data)
    .onConflictDoUpdate({
      target: [flowFieldSchemasTable.flowId, flowFieldSchemasTable.flowVersion],
      set: {
        fields: data.fields,
        syncedAt: new Date(),
        status: data.status ?? "active",
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/**
 * Get the most recently synced active schema for a flow.
 * Returns undefined if no active schema exists.
 */
export async function getActiveSchemaByFlowId(
  db: Database,
  flowId: string,
): Promise<FlowFieldSchema | undefined> {
  const [row] = await db
    .select()
    .from(flowFieldSchemasTable)
    .where(
      and(
        eq(flowFieldSchemasTable.flowId, flowId),
        eq(flowFieldSchemasTable.status, "active"),
      ),
    )
    .orderBy(desc(flowFieldSchemasTable.syncedAt))
    .limit(1);
  return row;
}

/**
 * Get a schema by exact flow_id + flow_version match.
 */
export async function getSchemaByFlowIdAndVersion(
  db: Database,
  flowId: string,
  flowVersion: string,
): Promise<FlowFieldSchema | undefined> {
  const [row] = await db
    .select()
    .from(flowFieldSchemasTable)
    .where(
      and(
        eq(flowFieldSchemasTable.flowId, flowId),
        eq(flowFieldSchemasTable.flowVersion, flowVersion),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Get all schema versions for a flow, ordered by most recently synced first.
 */
export async function getSchemasByFlowId(
  db: Database,
  flowId: string,
): Promise<FlowFieldSchema[]> {
  return db
    .select()
    .from(flowFieldSchemasTable)
    .where(eq(flowFieldSchemasTable.flowId, flowId))
    .orderBy(desc(flowFieldSchemasTable.syncedAt));
}

/**
 * Update the status of a schema record (e.g., "active" -> "deleted").
 * Also updates the updatedAt timestamp.
 */
export async function updateSchemaStatus(
  db: Database,
  id: number,
  status: "active" | "deleted",
): Promise<FlowFieldSchema | undefined> {
  const [row] = await db
    .update(flowFieldSchemasTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(flowFieldSchemasTable.id, id))
    .returning();
  return row;
}
