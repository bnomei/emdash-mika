import { createMika } from "@bnomei/emdash-mika/astro";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, url, redirect }) => {
  const token = params["token"];
  if (!token) return new Response("Missing token.", { status: 400 });

  const Mika = createMika({ request, url });
  const result = await Mika.download.resolve(token);

  if (!result.ok) {
    return new Response(result.error.message, { status: result.status });
  }

  if (result.data.redirectUrl) {
    return redirect(result.data.redirectUrl);
  }

  return new Response("Download unavailable.", { status: 404 });
};
