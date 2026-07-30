import { describe, expect, it } from "vitest";
import {
  isContainedAbsoluteChild,
  isContainedPath,
  isSafeAbsoluteRoot,
  isSafeRelativePath,
} from "../../src/safe/path.js";

describe("safe path primitives", () => {
  it("accepts only absolute non-root paths without traversal markers", () => {
    expect(isSafeAbsoluteRoot("/tmp/recordly")).toBe(true);
    expect(isSafeAbsoluteRoot("/")).toBe(false);
    expect(isSafeAbsoluteRoot("relative")).toBe(false);
    expect(isSafeAbsoluteRoot("/tmp/../etc")).toBe(false);
    expect(isSafeAbsoluteRoot("/tmp\\evil")).toBe(false);
  });

  it("requires candidates to stay under the root without escaping", () => {
    expect(isContainedPath("/tmp/root", "/tmp/root/a/b")).toBe(true);
    expect(isContainedPath("/tmp/root", "/tmp/root")).toBe(false);
    expect(isContainedPath("/tmp/root", "/tmp/other")).toBe(false);
    expect(isContainedPath("/tmp/root", "/tmp/root/../other")).toBe(false);
  });

  it("rejects absolute or traversal relative paths", () => {
    expect(isSafeRelativePath("frames/raw/frame-000001.jpg")).toBe(true);
    expect(isSafeRelativePath("/absolute")).toBe(false);
    expect(isSafeRelativePath("../escape")).toBe(false);
    expect(isSafeRelativePath("a\\b")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
  });

  it("requires MCP artifact children to be exact absolute prefixes of the root", () => {
    expect(isContainedAbsoluteChild("/tmp/root", "/tmp/root/a")).toBe(true);
    expect(isContainedAbsoluteChild("/tmp/root", "/tmp/root")).toBe(false);
    expect(isContainedAbsoluteChild("/", "/tmp/a")).toBe(false);
    expect(isContainedAbsoluteChild("/tmp/root", "/tmp/root/../x")).toBe(false);
    expect(isContainedAbsoluteChild("/tmp/root", "/tmp/root\\a")).toBe(false);
  });
});
