import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertReleaseMetadataVersions,
  assertReleaseVersion,
} from "../../scripts/assert-release-version.mjs";

describe("release tag version contract", () => {
  it("pins the canonical v0.5.0 release metadata", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version?: unknown };
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
      version?: unknown;
      packages?: { ""?: { version?: unknown } };
    };
    const plugin = JSON.parse(readFileSync(".codex-plugin/plugin.json", "utf8")) as {
      version?: unknown;
    };

    expect(pkg.version).toBe("0.5.0");
    expect(lock.version).toBe("0.5.0");
    expect(lock.packages?.[""]?.version).toBe("0.5.0");
    expect(plugin.version).toBe("0.5.0");
  });

  it("accepts only an exact v-prefixed package SemVer", () => {
    expect(() => assertReleaseVersion("v0.5.0", "0.5.0")).not.toThrow();
    expect(() => assertReleaseVersion("v0.5.1", "0.5.0")).toThrow(/equal/i);
    expect(() => assertReleaseVersion("v0.5.0-rc.2", "0.5.0-rc.1")).toThrow(/equal/i);
    expect(() => assertReleaseVersion("release-0.5.0", "0.5.0")).toThrow(/equal/i);
    expect(() => assertReleaseVersion(undefined, "0.5.0")).toThrow(/required/i);
    expect(() => assertReleaseVersion("v0.5", "0.5")).toThrow(/SemVer/i);
    expect(() => assertReleaseVersion("v0.5.0-01", "0.5.0-01")).toThrow(/SemVer/i);
    expect(() => assertReleaseVersion("v0.5.0-rc.01", "0.5.0-rc.01")).toThrow(/SemVer/i);
    expect(() => assertReleaseVersion("v0.5.0+build.01", "0.5.0+build.01")).not.toThrow();
  });

  it("rejects release metadata version drift", () => {
    expect(() => assertReleaseMetadataVersions("0.5.0", "0.5.0", "0.5.0", "0.5.0")).not.toThrow();
    expect(() => assertReleaseMetadataVersions("0.5.0", "0.4.0", "0.5.0", "0.5.0")).toThrow(
      /plugin/i,
    );
    expect(() => assertReleaseMetadataVersions("0.5.0", "0.5.0", "0.4.0", "0.5.0")).toThrow(
      /lock/i,
    );
    expect(() => assertReleaseMetadataVersions("0.5.0", "0.5.0", "0.5.0", "0.4.0")).toThrow(
      /lock/i,
    );
  });
});
