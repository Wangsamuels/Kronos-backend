/** One error shape everywhere: {error: {code, message, details?}} */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found`);
export const forbidden = (msg = "Not allowed") => new ApiError(403, "FORBIDDEN", msg);
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, "BAD_REQUEST", msg, details);
export const conflict = (msg: string, details?: unknown) => new ApiError(409, "CONFLICT", msg, details);
export const unauthorized = (msg = "Authentication required") => new ApiError(401, "UNAUTHORIZED", msg);
