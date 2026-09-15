# DigitalDrama TTS Backend

Standalone live text-to-speech API for the [DigitalDrama](../digital-drama-blog) site. Deployed separately from the frontend, on Netlify, since it's the one piece of the project that needs a real server (not a static host).

## Why this is a separate project

The main site (`digital-drama-blog/site`) is deployed as a fully static build on Cloudflare Pages. The one exception is audio playback — generating speech on demand and caching it — which needs an actual server route. Rather than split one Astro project across two hosts, this is a small standalone Astro project containing just that one endpoint, deployed on Netlify.

## Routes

- `GET /` — health check, returns `{ "status": "ok" }`.
- `POST /api/tts` — body `{ "slug": string, "section": "summary" | "opinion" }`. Returns cached audio if present in MongoDB, otherwise generates it via Cartesia, caches it, and returns it.

## Environment variables

See `.env.example`. Required:

- `MONGODB_URI` — same database as the main site (`digitalDrama`), used to read article text and cache generated audio.
- `CARTESIA_LIVE_API_KEY`, `CARTESIA_API_KEY`, `CARTESIA_API_KEY_2`, `CARTESIA_API_KEY_3`, `CARTESIA_BACKUP_API_KEY` — tried in that order; only a quota error falls through to the next key.
- `ALLOWED_ORIGIN` — comma-separated list of origins allowed to call this API in the browser (CORS). Defaults to `*`; tighten this to the real Cloudflare Pages / production domain once it's known.

## Local development

```bash
npm install
npm run dev
```

## Deploying

Deployed on Netlify via the official `@astrojs/netlify` adapter (already configured in `astro.config.mjs`). Connect this repo to a new Netlify site, set the environment variables above in the Netlify dashboard, and deploy — no build settings beyond the defaults (`npm run build`, publish directory `dist`) should be needed.

After deploying, update the frontend's `PUBLIC_TTS_API_URL` to point at `https://<this-site>.netlify.app/api/tts` (or a custom domain), and update `ALLOWED_ORIGIN` here to the frontend's real domain.
