import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ status: "ok", service: "digitaldrama-tts-backend" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
