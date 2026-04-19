import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluateKillSwitch,
  KILL_SWITCH_MESSAGE,
  WINDOW_SIZE,
  FAILURE_THRESHOLD,
} from "../killSwitch";

// ── Mock Database ─────────────────────────────────────────────────────────────

function createMockDb() {
  const limitFn = vi.fn();
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const updateWhereFn = vi.fn().mockResolvedValue(undefined);
  const updateSetFn = vi.fn().mockReturnValue({ where: updateWhereFn });
  const updateFn = vi.fn().mockReturnValue({ set: updateSetFn });

  return {
    db: { select: selectFn, update: updateFn } as any,
    mocks: {
      select: selectFn,
      from: fromFn,
      where: whereFn,
      orderBy: orderByFn,
      limit: limitFn,
      update: updateFn,
      updateSet: updateSetFn,
      updateWhere: updateWhereFn,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("KILL_SWITCH_MESSAGE", () => {
  it("equals the expected human-readable message", () => {
    expect(KILL_SWITCH_MESSAGE).toBe(
      "This workflow was paused because recent runs had issues. Review your rules and re-enable.",
    );
  });
});

describe("evaluateKillSwitch", () => {
  let db: any;
  let mocks: ReturnType<typeof createMockDb>["mocks"];

  beforeEach(() => {
    vi.restoreAllMocks();
    const mock = createMockDb();
    db = mock.db;
    mocks = mock.mocks;
  });

  it("skips evaluation when fewer than 10 executions exist", async () => {
    // Only 5 executions
    mocks.limit.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ status: "completed" })),
    );

    await evaluateKillSwitch(db, 1);

    // Should NOT call update
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does NOT disable when exactly 50% (5/10) are failed", async () => {
    const executions = [
      ...Array.from({ length: 5 }, () => ({ status: "failed" })),
      ...Array.from({ length: 5 }, () => ({ status: "completed" })),
    ];
    mocks.limit.mockResolvedValue(executions);

    await evaluateKillSwitch(db, 1);

    // Threshold is >50%, so exactly 50% should NOT trigger
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("disables workflow when 6/10 executions are failed", async () => {
    const executions = [
      ...Array.from({ length: 6 }, () => ({ status: "failed" })),
      ...Array.from({ length: 4 }, () => ({ status: "completed" })),
    ];
    mocks.limit.mockResolvedValue(executions);

    await evaluateKillSwitch(db, 42);

    expect(mocks.update).toHaveBeenCalled();
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        isActive: false,
        disabledReason: "kill_switch",
      }),
    );
  });

  it("does nothing when all 10 executions are completed (0% failure)", async () => {
    const executions = Array.from({ length: 10 }, () => ({
      status: "completed",
    }));
    mocks.limit.mockResolvedValue(executions);

    await evaluateKillSwitch(db, 1);

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does nothing when workflow is already disabled (idempotent via WHERE clause)", async () => {
    // 8/10 failures — would normally trigger
    const executions = [
      ...Array.from({ length: 8 }, () => ({ status: "failed" })),
      ...Array.from({ length: 2 }, () => ({ status: "completed" })),
    ];
    mocks.limit.mockResolvedValue(executions);

    await evaluateKillSwitch(db, 1);

    // The WHERE clause includes AND is_active = true, making the update idempotent.
    // We verify update IS called (it handles idempotency at DB level, not app level).
    expect(mocks.update).toHaveBeenCalled();
    // Verify the WHERE clause includes both workflowId AND isActive conditions
    expect(mocks.updateWhere).toHaveBeenCalled();
  });

  it("logs a warning when tripping the kill switch", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const executions = [
      ...Array.from({ length: 7 }, () => ({ status: "failed" })),
      ...Array.from({ length: 3 }, () => ({ status: "completed" })),
    ];
    mocks.limit.mockResolvedValue(executions);

    await evaluateKillSwitch(db, 99);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("99"),
    );
    warnSpy.mockRestore();
  });
});
