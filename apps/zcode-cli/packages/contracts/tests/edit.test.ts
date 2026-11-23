import { describe, expect, it } from "vitest";
import { EditErrorCode } from "../src/tools/edit.js";

describe("Edit contracts", () => {
  it("exports the handler error codes from one source", () => {
    expect(EditErrorCode).toEqual({
      NO_CHANGE: 1,
      FILE_EXISTS_NO_OLD_STRING: 3,
      FILE_NOT_EXIST: 4,
      NOTEBOOK_FILE: 5,
      FILE_NOT_READ: 6,
      STALE_FILE: 7,
      OLD_STRING_NOT_FOUND: 8,
      AMBIGUOUS_REPLACE: 9,
      FILE_TOO_LARGE: 10,
      INVALID_PATH: 13,
      UNSUPPORTED_ENCODING: 15,
    });
  });
});
