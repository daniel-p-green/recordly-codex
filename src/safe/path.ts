import { isAbsolute, relative } from "node:path";

/** Absolute workspace roots that are never `/` and never carry traversal markers. */
export function isSafeAbsoluteRoot(value: string): boolean {
  return isAbsolute(value) && value !== "/" && !value.includes("\\") && !value.includes("..");
}

/**
 * True when `candidate` resolves strictly inside `root` (not equal to root).
 * Lexical only — callers that need symlink safety must also `realpath` + re-check.
 */
export function isContainedPath(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate) || candidate.includes("\\")) return false;
  const relation = relative(root, candidate);
  return relation.length > 0 && !relation.startsWith("..") && !isAbsolute(relation);
}

/** Relative artifact paths with no empty, `.`, or `..` segments. */
export function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

/**
 * Handler-facing check: `value` must be an absolute path whose prefix is exactly `root/`.
 * Stricter than {@link isContainedPath} for MCP-returned absolute artifact paths.
 */
export function isContainedAbsoluteChild(root: string, value: string): boolean {
  if (
    !root.startsWith("/") ||
    root === "/" ||
    root.includes("\\") ||
    root.includes("..") ||
    value.includes("\\")
  ) {
    return false;
  }
  if (!value.startsWith(`${root}/`) || value.includes("..")) return false;
  return value
    .split("/")
    .slice(1)
    .every((segment) => segment.length > 0 && segment !== ".");
}
