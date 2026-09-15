import dns from "node:dns";
import { MongoClient, type Db } from "mongodb";

// Some networks (notably Windows behind certain routers/VPNs) refuse SRV
// record lookups, which mongodb+srv:// requires. Prefer public resolvers
// that support them, falling back to whatever was already configured. Purely
// a local-dev convenience — wrapped in try/catch since serverless runtimes
// (e.g. Netlify Functions) can disallow changing DNS servers outright, which
// would otherwise crash the function before it ever handles a request.
try {
  dns.setServers(["1.1.1.1", "8.8.8.8", ...dns.getServers()]);
} catch (err) {
  console.warn(`[mongodb] Could not override DNS servers, continuing with defaults: ${(err as Error).message}`);
}

export interface Article {
  _id?: string;
  title: string;
  slug: string;
  summary: string;
  opinion: string;
}

export type AudioSection = "summary" | "opinion";

interface AudioDoc {
  slug: string;
  section: AudioSection;
  audio: string;
}

const uri = import.meta.env.MONGODB_URI ?? process.env.MONGODB_URI;

let client: MongoClient | null = null;
let db: Db | null = null;

async function getDb(): Promise<Db> {
  if (db) return db;
  if (!uri) throw new Error("MONGODB_URI is not set");
  client = new MongoClient(uri);
  await client.connect();
  db = client.db("digitalDrama");
  return db;
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  try {
    const database = await getDb();
    const article = await database.collection<Article>("articles").findOne({ slug });
    return article ? JSON.parse(JSON.stringify(article)) : null;
  } catch (err) {
    console.warn(`[mongodb] Skipping article lookup, could not connect: ${(err as Error).message}`);
    return null;
  }
}

export async function getCachedAudio(slug: string, section: AudioSection): Promise<string | null> {
  const database = await getDb();
  const doc = await database.collection<AudioDoc>("audio").findOne({ slug, section });
  return doc ? doc.audio : null;
}

export async function saveArticleAudio(slug: string, section: AudioSection, dataUri: string): Promise<void> {
  const database = await getDb();
  await database
    .collection<AudioDoc>("audio")
    .updateOne({ slug, section }, { $set: { slug, section, audio: dataUri } }, { upsert: true });
}
