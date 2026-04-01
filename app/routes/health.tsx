// Intentionally unauthenticated — external monitoring (Railway) needs to probe this endpoint.
export const loader = async () => {
  return Response.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
};
