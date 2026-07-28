import { describe, expect, it } from "vitest";

import { averagePpmRegion, isRgbWithin, parsePpm, ppmPixelAt } from "../support/ppm.js";

describe("portable pixmap parser", () => {
  it("parses a P6 image with comments and CRLF header boundaries", () => {
    const ppm = parsePpm(
      Buffer.concat([
        Buffer.from("P6\r\n# generated fixture\r\n2 1\r\n255\r\n", "ascii"),
        Buffer.from([1, 2, 3, 21, 22, 23]),
      ]),
    );
    expect(ppm).toMatchObject({ width: 2, height: 1, maxValue: 255 });
    expect(ppmPixelAt(ppm, 1, 0)).toEqual({ r: 21, g: 22, b: 23 });
    expect(averagePpmRegion(ppm, 0, 0, 2, 1)).toEqual({ r: 11, g: 12, b: 13 });
  });

  it("rejects malformed headers, truncated pixels, trailing bytes, and invalid regions", () => {
    expect(() => parsePpm(Buffer.from("P3\n1 1\n255\n\0\0\0", "binary"))).toThrow(/P6/i);
    expect(() => parsePpm(Buffer.from("P6\n1 1\n256\n\0\0\0", "binary"))).toThrow(/255/i);
    expect(() => parsePpm(Buffer.from("P6\n1 1\n255\n\0\0", "binary"))).toThrow(/length/i);
    expect(() => parsePpm(Buffer.from("P6\n1 1\n255\n\0\0\0\0", "binary"))).toThrow(/length/i);
    const ppm = parsePpm(Buffer.from("P6\n1 1\n255\n\0\0\0", "binary"));
    expect(() => ppmPixelAt(ppm, 1, 0)).toThrow(/bounds/i);
    expect(() => averagePpmRegion(ppm, 0, 0, 2, 1)).toThrow(/bounds/i);
    expect(() => isRgbWithin({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, -1)).toThrow(/tolerance/i);
  });
});
