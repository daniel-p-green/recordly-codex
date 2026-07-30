import { describe, expect, it } from "vitest";
import {
  asPlainObject,
  asSafeInteger,
  assertExactKeys,
  hasExactKeys,
} from "../../src/safe/object.js";

describe("safe object primitives", () => {
  it("accepts plain objects and rejects arrays or null", () => {
    expect(asPlainObject({ a: 1 }, "value")).toEqual({ a: 1 });
    expect(() => asPlainObject([], "value")).toThrow(/plain object/);
    expect(() => asPlainObject(null, "value")).toThrow(/plain object/);
  });

  it("enforces exact key sets", () => {
    const value = { a: 1, b: 2 };
    expect(() => assertExactKeys(value, ["a", "b"], "value")).not.toThrow();
    expect(() => assertExactKeys(value, ["a"], "value")).toThrow(/exactly/);
    expect(hasExactKeys(value, ["a", "b"])).toBe(true);
    expect(hasExactKeys(value, ["a"])).toBe(false);
  });

  it("bounds safe integers", () => {
    expect(asSafeInteger(3, "n", 0, 10)).toBe(3);
    expect(() => asSafeInteger(1.5, "n")).toThrow(/integer/);
    expect(() => asSafeInteger(-1, "n", 0)).toThrow(/integer/);
  });
});
