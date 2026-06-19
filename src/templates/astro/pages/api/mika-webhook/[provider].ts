import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async ({ params }) => {
  const provider = params["provider"];
  if (!provider) return new Response("Missing provider.", { status: 400 });

  return Response.json(
    {
      ok: false,
      error: {
        code: "NOT_IMPLEMENTED",
        message: `Wire ${provider} webhook verification to a server-side Mika provider adapter.`,
      },
    },
    { status: 501 },
  );
};
