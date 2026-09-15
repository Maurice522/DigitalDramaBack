import type { APIRoute } from "astro";
import { getArticleBySlug, getCachedAudio, saveArticleAudio, type AudioSection } from "../../lib/mongodb";

export const prerender = false;

const CARTESIA_VOICE_ID = "a33f7a4c-100f-41cf-a1fd-5822e8fc253f";

// The frontend now lives on a different origin (Cloudflare Pages), so every
// response needs CORS headers. ALLOWED_ORIGIN can be a comma-separated list
// once the real frontend domain is known; until then it defaults to "*",
// which is safe here since this endpoint takes no cookies/credentials.
function resolveAllowedOrigin(request: Request): string {
  const configured = (import.meta.env.ALLOWED_ORIGIN ?? process.env.ALLOWED_ORIGIN ?? "*").trim();
  if (configured === "*") return "*";
  const allowList = configured.split(",").map((o) => o.trim());
  const requestOrigin = request.headers.get("origin") ?? "";
  return allowList.includes(requestOrigin) ? requestOrigin : allowList[0];
}

function corsHeaders(request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": resolveAllowedOrigin(request),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function jsonError(message: string, status: number, request: Request) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(request) },
  });
}

function dataUriToBuffer(dataUri: string): { buffer: Buffer; contentType: string } {
  const match = dataUri.match(/^data:([^;]+);base64,(.*)$/s);
  if (!match) throw new Error("Malformed stored audio data URI");
  return { buffer: Buffer.from(match[2], "base64"), contentType: match[1] };
}

async function callCartesia(text: string, apiKey: string): Promise<Buffer> {
  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      "Cartesia-Version": "2026-08-14",
    },
    body: JSON.stringify({
      model_id: "sonic-3.6",
      transcript: text,
      voice: { mode: "id", id: CARTESIA_VOICE_ID },
      // mp3 rather than raw wav — a full section at normal speed can produce
      // an 8-9MB uncompressed wav, which is wasteful to store/transfer and
      // risks pushing a cached document over MongoDB's 16MB limit.
      output_format: { container: "mp3", bit_rate: 64000, sample_rate: 44100 },
      generation_config: { speed: 1, volume: 0.7, emotion: "excited" },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Cartesia request failed: ${res.status} ${detail}`) as Error & {
      isQuotaError?: boolean;
    };
    err.isQuotaError = res.status === 402;
    throw err;
  }

  return Buffer.from(await res.arrayBuffer());
}

// Tries each key in order; only a quota/credit error (402) falls through to
// the next one — any other failure stops immediately since a different key
// won't fix a bad request or network issue.
async function generateWithCartesia(text: string, apiKeys: string[]): Promise<Buffer> {
  let lastErr: Error | undefined;
  for (let i = 0; i < apiKeys.length; i++) {
    try {
      return await callCartesia(text, apiKeys[i]);
    } catch (err) {
      lastErr = err as Error;
      if (!(err as { isQuotaError?: boolean }).isQuotaError) throw err;
      console.warn(`[tts] Cartesia key #${i + 1} out of quota, trying next key...`);
    }
  }
  throw lastErr ?? new Error("No Cartesia API key configured");
}

export const OPTIONS: APIRoute = async ({ request }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
};

export const POST: APIRoute = async (context) => {
  try {
    return await handlePost(context);
  } catch (err) {
    console.error(`[tts] Unhandled error: ${(err as Error).stack ?? (err as Error).message}`);
    return jsonError("Internal server error", 500, context.request);
  }
};

async function handlePost({ request }: Parameters<APIRoute>[0]): ReturnType<APIRoute> {
  let body: { slug?: string; section?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400, request);
  }

  const slug = body.slug;
  const section = body.section as AudioSection | undefined;
  if (!slug || (section !== "summary" && section !== "opinion")) {
    return jsonError("slug and section ('summary' | 'opinion') are required", 400, request);
  }

  const cached = await getCachedAudio(slug, section);
  if (cached) {
    try {
      const { buffer, contentType } = dataUriToBuffer(cached);
      return new Response(buffer, { status: 200, headers: { "content-type": contentType, ...corsHeaders(request) } });
    } catch (err) {
      console.warn(`[tts] Stored audio for ${slug}/${section} was malformed, regenerating: ${(err as Error).message}`);
    }
  }

  const article = await getArticleBySlug(slug);
  if (!article) return jsonError("Article not found", 404, request);

  // The automation pipeline no longer pre-generates audio at creation time
  // (disabled to save quota — articles are saved with no audio, and the
  // first listener request is what triggers generation), so CARTESIA_API_KEY
  // / _2 / _3 sit idle outside of the manual backfill script. Rather than
  // waste that quota, every key is available here as a fallback chain so a
  // listener is never told "no speech available" just because the primary
  // live key ran dry.
  const apiKeys = [
    import.meta.env.CARTESIA_LIVE_API_KEY ?? process.env.CARTESIA_LIVE_API_KEY,
    import.meta.env.CARTESIA_API_KEY ?? process.env.CARTESIA_API_KEY,
    import.meta.env.CARTESIA_API_KEY_2 ?? process.env.CARTESIA_API_KEY_2,
    import.meta.env.CARTESIA_API_KEY_3 ?? process.env.CARTESIA_API_KEY_3,
    import.meta.env.CARTESIA_BACKUP_API_KEY ?? process.env.CARTESIA_BACKUP_API_KEY,
  ].filter((key): key is string => Boolean(key));
  if (apiKeys.length === 0) return jsonError("CARTESIA_LIVE_API_KEY is not set", 500, request);

  const text = (article[section] ?? "").trim();
  if (!text) return jsonError(`Article has no ${section} text`, 400, request);

  let audioBuffer: Buffer;
  try {
    audioBuffer = await generateWithCartesia(text, apiKeys);
  } catch (err) {
    return jsonError(`Could not reach Cartesia: ${(err as Error).message}`, 502, request);
  }

  const dataUri = `data:audio/mpeg;base64,${audioBuffer.toString("base64")}`;
  try {
    await saveArticleAudio(slug, section, dataUri);
  } catch (err) {
    console.warn(`[tts] Failed to cache audio for ${slug}/${section}: ${(err as Error).message}`);
  }

  return new Response(audioBuffer, { status: 200, headers: { "content-type": "audio/mpeg", ...corsHeaders(request) } });
};
