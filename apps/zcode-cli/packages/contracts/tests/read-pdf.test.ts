import { describe, expect, it } from "vitest";
import {
  READ_PDF_MAX_PAGES_PER_REQUEST,
  READ_PDF_PAGES_DESCRIPTION,
  ReadInputJsonSchema,
  ReadInputSchema,
  ReadPdfInputJsonSchema,
  getReadInputValidationFailure,
  getReadPdfPagesValidationFailure,
  parseReadPdfPageRange,
} from "../src/tools/read.js";

describe("Read PDF contract", () => {
  it("keeps pages out of the legacy Read schema and exposes the exact PDF schema field", () => {
    expect(ReadInputJsonSchema.properties).not.toHaveProperty("pages");
    expect(ReadPdfInputJsonSchema.properties).toMatchObject({
      pages: {
        description: READ_PDF_PAGES_DESCRIPTION,
        type: "string",
      },
    });
    expect(READ_PDF_PAGES_DESCRIPTION).toBe(
      'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
    );
  });

  it("parses PDF page syntax and rejects invalid or over-wide ranges", () => {
    expect(parseReadPdfPageRange("3")).toEqual({ firstPage: 3, lastPage: 3 });
    expect(parseReadPdfPageRange("2-5")).toEqual({ firstPage: 2, lastPage: 5 });
    expect(parseReadPdfPageRange("10-")).toEqual({ firstPage: 10, lastPage: Infinity });
    expect(parseReadPdfPageRange("0")).toBeUndefined();
    expect(parseReadPdfPageRange("5-4")).toBeUndefined();

    // 页码检查在 Read validateInput（getReadInputValidationFailure），runtime schema 不再拒绝。
    expect(getReadInputValidationFailure("/tmp/report.pdf", "1-20")).toBeUndefined();
    expect(
      getReadInputValidationFailure("/tmp/report.pdf", `1-${READ_PDF_MAX_PAGES_PER_REQUEST + 1}`),
    ).toEqual({
      errorCode: 8,
      message:
        'Page range "1-21" exceeds maximum of 20 pages per request. Please use a smaller range.',
    });
    expect(getReadInputValidationFailure("/tmp/report.pdf", "10-")?.message).toBe(
      'Page range "10-" exceeds maximum of 20 pages per request. Please use a smaller range.',
    );
    expect(ReadInputSchema.safeParse({ file_path: "/tmp/report.pdf", pages: "1-21" }).success).toBe(
      true,
    );
  });

  it("does not apply PDF page validation to non-PDF compatibility calls", () => {
    expect(getReadInputValidationFailure("/tmp/notes.txt", "not-a-range")).toBeUndefined();
  });

  it("returns the binary and device path failures with their error codes", () => {
    expect(getReadInputValidationFailure("/tmp/archive.zip")).toEqual({
      errorCode: 4,
      message:
        "This tool cannot read binary files. The file appears to be a binary .zip file. Use a skill for this file type if one is available, or a shell command or script that can read the format.",
    });
    expect(getReadInputValidationFailure("/dev/zero")).toEqual({
      errorCode: 9,
      message:
        "Cannot read '/dev/zero': this path names a device or process file that this tool does not read.",
    });
    expect(getReadInputValidationFailure("/tmp/notes.txt")).toBeUndefined();
    expect(ReadInputSchema.safeParse({ file_path: "/dev/zero" }).success).toBe(true);
  });

  it("returns the exact validation messages and error codes for PDF pages", () => {
    expect(getReadPdfPagesValidationFailure("/tmp/report.pdf", "invalid")).toEqual({
      errorCode: 7,
      message:
        'Invalid pages parameter: "invalid". Give one page ("3") or one range ("1-5"), not a list. To read several pages or ranges, read each one separately. Pages are 1-indexed.',
    });
    expect(getReadPdfPagesValidationFailure("/tmp/report.pdf", "1-21")).toEqual({
      errorCode: 8,
      message:
        'Page range "1-21" exceeds maximum of 20 pages per request. Please use a smaller range.',
    });
    expect(getReadPdfPagesValidationFailure("/tmp/notes.txt", "invalid")).toBeUndefined();
  });
});
