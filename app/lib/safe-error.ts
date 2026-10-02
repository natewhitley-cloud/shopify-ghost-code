/**
 * Log-safe view of a thrown value: name and code only, NEVER the message.
 * Prisma validation errors embed the offending `data` (e.g. a recipient email)
 * in their message, so any path that handles recipient PII must log this
 * instead of the error object or its message.
 */
export function safeErrorFields(error: unknown): { errorName: string; errorCode?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      errorName: error.name,
      ...(typeof code === "string" ? { errorCode: code } : {}),
    };
  }
  return { errorName: typeof error };
}
