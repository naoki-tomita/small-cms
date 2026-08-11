import { HttpError, MethodNotAllowedError, ValidationError } from "./errors.ts";

const CORS_HEADERS: Record<string, string> = {
  // The API is stateless and unauthenticated, so there is nothing for a browser to leak here.
  // This is what lets a frontend be added later without touching the server.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...headers },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Renders any error as `{ "error": { code, message, details? } }`. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const headers: Record<string, string> = error instanceof MethodNotAllowedError
      ? { allow: error.allowed.join(", ") }
      : {};

    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details && error.details.length > 0 ? { details: error.details } : {}),
        },
      },
      error.status,
      headers,
    );
  }

  console.error("Unhandled error:", error);
  return json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType && !contentType.includes("application/json")) {
    throw new ValidationError(`Content-Type must be application/json, got "${contentType}"`);
  }

  const raw = await request.text();
  if (raw.trim() === "") {
    throw new ValidationError("Request body is empty");
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ValidationError(
      `Request body is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface ListQuery {
  limit: number;
  offset: number;
  order: "asc" | "desc";
}

/** Parses `?limit=&offset=&order=` for collection endpoints. */
export function parseListQuery(params: URLSearchParams): ListQuery {
  return {
    limit: parseBoundedInt(params.get("limit"), "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: parseBoundedInt(params.get("offset"), "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    order: parseOrder(params.get("order")),
  };
}

function parseBoundedInt(
  raw: string | null,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError("Invalid query parameter", [
      { field: name, message: `must be an integer between ${min} and ${max}` },
    ]);
  }
  return value;
}

function parseOrder(raw: string | null): "asc" | "desc" {
  if (raw === null || raw === "") return "desc";
  if (raw === "asc" || raw === "desc") return raw;

  throw new ValidationError("Invalid query parameter", [
    { field: "order", message: 'must be "asc" or "desc"' },
  ]);
}

/** Throws a 405 carrying an `Allow` header unless the request uses one of `allowed`. */
export function requireMethod(request: Request, allowed: string[]): string {
  if (!allowed.includes(request.method)) {
    throw new MethodNotAllowedError(allowed);
  }
  return request.method;
}
