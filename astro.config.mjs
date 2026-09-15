// @ts-check
import { defineConfig } from "astro/config";
import netlify from "@astrojs/netlify";

// This project is just the live TTS endpoint for the DigitalDrama site
// (deployed separately, on Cloudflare Pages). Everything here is
// server-rendered on demand rather than pre-built — there's no static
// content to speak of, just one API route plus a health-check page.
export default defineConfig({
  output: "server",
  adapter: netlify(),
});
