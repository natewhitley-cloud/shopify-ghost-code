export const loader = async () => {
  return Response.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
};
