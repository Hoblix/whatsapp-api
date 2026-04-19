// FROZEN: v1 behavior — do not modify these expectations without version migration
import { describe, it, expect } from "vitest";
import { evaluateCondition } from "../automationEngine";

describe("evaluateCondition (v1 frozen)", () => {
  describe("eq operator", () => {
    it("returns true for matching strings", () => {
      expect(evaluateCondition("hello", { operator: "eq", value: "hello" })).toBe(true);
    });

    it("coerces number to string for comparison", () => {
      expect(evaluateCondition(123, { operator: "eq", value: "123" })).toBe(true);
    });

    it("returns false for mismatched strings", () => {
      expect(evaluateCondition("hello", { operator: "eq", value: "world" })).toBe(false);
    });

    it("coerces null to string 'null'", () => {
      expect(evaluateCondition(null, { operator: "eq", value: "null" })).toBe(true);
    });

    it("coerces undefined to string 'undefined'", () => {
      expect(evaluateCondition(undefined, { operator: "eq", value: "undefined" })).toBe(true);
    });
  });

  describe("neq operator", () => {
    it("returns true for different values", () => {
      expect(evaluateCondition("a", { operator: "neq", value: "b" })).toBe(true);
    });

    it("returns false for same values", () => {
      expect(evaluateCondition("same", { operator: "neq", value: "same" })).toBe(false);
    });
  });

  describe("contains operator", () => {
    it("returns true when string contains substring", () => {
      expect(evaluateCondition("hello world", { operator: "contains", value: "world" })).toBe(true);
    });

    it("is case-sensitive", () => {
      expect(evaluateCondition("Hello", { operator: "contains", value: "hello" })).toBe(false);
    });

    it("returns false when value is not a string", () => {
      expect(evaluateCondition(123, { operator: "contains", value: "1" })).toBe(false);
    });

    it("returns false when expected is not a string", () => {
      expect(evaluateCondition("hello", { operator: "contains", value: 123 })).toBe(false);
    });
  });

  describe("exists operator", () => {
    it("returns true for non-null/undefined value", () => {
      expect(evaluateCondition("something", { operator: "exists" })).toBe(true);
    });

    it("returns false for null", () => {
      expect(evaluateCondition(null, { operator: "exists" })).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(evaluateCondition(undefined, { operator: "exists" })).toBe(false);
    });

    it("returns true for empty string (exists but empty)", () => {
      expect(evaluateCondition("", { operator: "exists" })).toBe(true);
    });

    it("returns true for 0 (exists but falsy)", () => {
      expect(evaluateCondition(0, { operator: "exists" })).toBe(true);
    });

    it("returns true for false (exists but falsy)", () => {
      expect(evaluateCondition(false, { operator: "exists" })).toBe(true);
    });
  });

  describe("not_exists operator", () => {
    it("returns true for null", () => {
      expect(evaluateCondition(null, { operator: "not_exists" })).toBe(true);
    });

    it("returns true for undefined", () => {
      expect(evaluateCondition(undefined, { operator: "not_exists" })).toBe(true);
    });

    it("returns false for non-null value", () => {
      expect(evaluateCondition("value", { operator: "not_exists" })).toBe(false);
    });
  });

  describe("default operator", () => {
    it("always returns true regardless of value", () => {
      expect(evaluateCondition("anything", { operator: "default" })).toBe(true);
    });

    it("returns true even for null value", () => {
      expect(evaluateCondition(null, { operator: "default" })).toBe(true);
    });

    it("returns true even for undefined value", () => {
      expect(evaluateCondition(undefined, { operator: "default" })).toBe(true);
    });
  });

  describe("unknown operators", () => {
    it("returns false for 'gt' operator", () => {
      expect(evaluateCondition(10, { operator: "gt", value: 5 })).toBe(false);
    });

    it("returns false for 'lt' operator", () => {
      expect(evaluateCondition(5, { operator: "lt", value: 10 })).toBe(false);
    });

    it("returns false for arbitrary unknown operator", () => {
      expect(evaluateCondition("x", { operator: "foo", value: "x" })).toBe(false);
    });
  });
});
