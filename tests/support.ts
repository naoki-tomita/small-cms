import { HttpError, type ValidationIssue } from "../src/errors.ts";

/** Runs `fn` and returns the `HttpError` it threw, failing the test if it threw anything else. */
export function catchHttpError(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw new Error(`Expected an HttpError, got: ${error}`);
  }
  throw new Error("Expected an HttpError, but nothing was thrown");
}

/** The `field` of every validation issue raised by `fn`, in order. */
export function issueFields(fn: () => unknown): string[] {
  return (catchHttpError(fn).details ?? []).map((issue: ValidationIssue) => issue.field);
}
