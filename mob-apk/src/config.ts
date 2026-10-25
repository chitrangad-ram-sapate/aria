// Every setting and business limit the app uses, in one place. Values that depend on where the app runs can be
// changed at build time in .env.local (see .env.example); the rest are product rules shared by several screens.
// Limits marked "rules" are enforced again by firestore.rules, which cannot import this file: change both together.

const env: Record<string, string | undefined> = (import.meta as any).env ?? {};
const num = (v: string | undefined, d: number) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/** Firebase project (public web config; access is controlled by firestore.rules). Override all of it to run your own. */
export const FIREBASE_CONFIG = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'AIzaSyAV06-tVPPbJK2mg704BlVJTsRcUwhmpUg',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'aria-triwiz.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'aria-triwiz',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'aria-triwiz.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_SENDER_ID || '896686551571',
  appId: env.VITE_FIREBASE_APP_ID || '1:896686551571:web:244b023e538ba96d5545e6',
};

/** Local test runs (?emulators=1 on this host) use the Firebase emulators, never the live project. */
export const EMULATORS = {
  host: env.VITE_EMULATOR_HOST || 'localhost',
  authPort: num(env.VITE_EMULATOR_AUTH_PORT, 9099),
  firestorePort: num(env.VITE_EMULATOR_FIRESTORE_PORT, 8080),
  projectId: 'demo-aria',
};

/** Map tiles for OpenStreetMap through Leaflet (the default map). Heavy use should point at your own tile server. */
export const MAP_TILES = {
  url: env.VITE_MAP_TILES_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: env.VITE_MAP_TILES_ATTRIBUTION || '&copy; OpenStreetMap contributors',
  maxZoom: num(env.VITE_MAP_TILES_MAX_ZOOM, 19),
};

/** Ask ARIA's language model (Groq, OpenAI-style API). It only reads questions and words answers; every number comes
 *  from the engine on the phone. No key, no connection or an error: the chat reads questions with src/assistant.ts. */
export const AI = {
  key: env.VITE_GROQ_API_KEY || '',
  url: env.VITE_GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions',
  model: env.VITE_GROQ_MODEL || 'openai/gpt-oss-120b',
  fallback: env.VITE_GROQ_FALLBACK_MODEL || 'openai/gpt-oss-20b', // used when the main model is busy (rate limit)
  timeoutMs: num(env.VITE_GROQ_TIMEOUT_MS, 12000),
};

/** Team join codes: easy to read out loud (no 0/O, 1/I/L). */
export const TEAM_CODE = { length: 6, chars: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' };

/** The shop's delivery code (rules: 5 tries, digits only). */
export const SHOP_CODE = { digits: 6, validHours: 24, maxTries: 5 };

/** Arrival rules an admin may set, as [min, max] (rules: validPolicy). */
export const POLICY_LIMITS = {
  radius_m: [20, 1000],
  max_accuracy_m: [5, 200],
  max_age_s: [5, 300],
  readings: [1, 5],
} as const;

/** How much the screens and listeners keep: the latest trips (with their stops), and list lengths. */
export const LIST = { trips: 30, files: 30, reports: 30, driverReports: 20, deliveries: 60, dataErrors: 30, recentFiles: 20 };

/** Largest data CSV the app reads. */
export const CSV_MAX_MB = 20;

/** Today's date on this phone as YYYY-MM-DD (local time: toISOString() would give yesterday in India before 5:30 am). */
export function today(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
