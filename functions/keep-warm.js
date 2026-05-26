exports.handler = async (event) => {
  // Ping your own API to keep the function + Neon connection warm
  await fetch(`${process.env.URL}/api/products`, {
    method: 'HEAD' // lightweight, no body needed
  });
  return { statusCode: 200, body: 'warmed' };
};
