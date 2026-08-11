/** Details attached to a validation failure, one entry per offending field. */
export interface ValidationIssue {
  field: string;
  message: string;
}

/** An error that carries the HTTP status and machine readable code to respond with. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ValidationIssue[];

  constructor(status: number, code: string, message: string, details?: ValidationIssue[]) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details: ValidationIssue[] = []) {
    super(400, "validation_error", message, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, "not_found", message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, "conflict", message);
    this.name = "ConflictError";
  }
}

export class MethodNotAllowedError extends HttpError {
  readonly allowed: string[];

  constructor(allowed: string[]) {
    super(405, "method_not_allowed", `Allowed methods: ${allowed.join(", ")}`);
    this.name = "MethodNotAllowedError";
    this.allowed = allowed;
  }
}
