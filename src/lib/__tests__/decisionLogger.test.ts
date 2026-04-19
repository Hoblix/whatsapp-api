import { describe, it, expect, vi } from "vitest";
import {
  shouldLog,
  buildDecisionEntry,
  flushDecisionLog,
} from "../decisionLogger";
import type { DecisionEntry, DecisionRecord } from "../decisionLogger";
import type { ConditionV2Entry, ConditionResult } from "../conditionEngineV2.types";
import type { MappedField } from "../webhookMapper";

// ── shouldLog ──────────────────────────────────────────────────────────────

describe("shouldLog", () => {
  it("returns true for FAILED regardless of debugMode", () => {
    expect(shouldLog(false, "FAILED")).toBe(true);
    expect(shouldLog(true, "FAILED")).toBe(true);
  });

  it("returns false for TRUE when debugMode is off", () => {
    expect(shouldLog(false, "TRUE")).toBe(false);
  });

  it("returns false for FALSE when debugMode is off", () => {
    expect(shouldLog(false, "FALSE")).toBe(false);
  });

  it("returns true for TRUE when debugMode is on", () => {
    expect(shouldLog(true, "TRUE")).toBe(true);
  });

  it("returns true for FALSE when debugMode is on", () => {
    expect(shouldLog(true, "FALSE")).toBe(true);
  });
});

// ── buildDecisionEntry ─────────────────────────────────────────────────────

describe("buildDecisionEntry", () => {
  const entry: ConditionV2Entry = {
    field_key: "favorite_color",
    operator: "eq",
    value: "Blue",
  };

  const mapped: MappedField = {
    field_key: "favorite_color",
    raw_value: "Blue",
    normalized_value: "blue",
    status: "confirmed",
    transforms_applied: ["trim", "lowercase"],
  };

  it("produces correct shape for TRUE result", () => {
    const result: ConditionResult = { result: "TRUE" };
    const de = buildDecisionEntry(entry, mapped, result);

    expect(de).toEqual({
      field_key: "favorite_color",
      raw_value: "Blue",
      normalized_value: "blue",
      operator: "eq",
      expected_value: "Blue",
      result: "TRUE",
    });
  });

  it("produces correct shape for FALSE result", () => {
    const result: ConditionResult = { result: "FALSE" };
    const de = buildDecisionEntry(entry, mapped, result);

    expect(de.result).toBe("FALSE");
    expect(de.failed_reason).toBeUndefined();
  });

  it("includes failed_reason for FAILED result", () => {
    const result: ConditionResult = {
      result: "FAILED",
      reason: "FIELD_MISSING",
      message: "We couldn't find this answer in the user's response",
    };
    const de = buildDecisionEntry(entry, undefined, result);

    expect(de.result).toBe("FAILED");
    expect(de.failed_reason).toBe("FIELD_MISSING");
    expect(de.raw_value).toBeNull();
    expect(de.normalized_value).toBeNull();
  });

  it("handles undefined mapped field gracefully", () => {
    const result: ConditionResult = { result: "FALSE" };
    const de = buildDecisionEntry(entry, undefined, result);

    expect(de.raw_value).toBeNull();
    expect(de.normalized_value).toBeNull();
  });
});

// ── flushDecisionLog ───────────────────────────────────────────────────────

describe("flushDecisionLog", () => {
  it("calls db.insert with correct table and values", async () => {
    const returningFn = vi.fn().mockResolvedValue([{ id: 1 }]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const mockDb = { insert: insertFn } as any;

    const record: DecisionRecord = {
      workflowId: 1,
      executionId: 10,
      nodeId: "cond-1",
      schemaVersion: "v1.0",
      logic: "and",
      durationMs: 42,
      decisions: [],
      finalResult: "TRUE",
      branchTaken: "5",
    };

    await flushDecisionLog(mockDb, record);

    expect(insertFn).toHaveBeenCalledTimes(1);
    expect(valuesFn).toHaveBeenCalledTimes(1);

    const insertedValues = valuesFn.mock.calls[0][0];
    expect(insertedValues.workflowId).toBe(1);
    expect(insertedValues.executionId).toBe(10);
    expect(insertedValues.nodeId).toBe("cond-1");
    expect(insertedValues.schemaVersion).toBe("v1.0");
    expect(insertedValues.logic).toBe("and");
    expect(insertedValues.durationMs).toBe(42);
    expect(insertedValues.decisions).toEqual([]);
    expect(insertedValues.finalResult).toBe("TRUE");
    expect(insertedValues.branchTaken).toBe("5");
  });
});
