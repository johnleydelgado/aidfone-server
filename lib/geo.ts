import type { Request } from 'express';

// ---------------------------------------------------------------------------
// US-gate prep (US / dual-currency ticket — spec pending).
//
// Resolves the visitor's country so the checkout flow can ALLOW Canada + the
// United States and show a "coming to your region soon" screen to everyone
// else. Resolution is header-first, then IP fallback:
//
//   1. CDN/proxy geo header (Cloudflare `cf-ipcountry`, Netlify, Vercel, GAE)
//      — instant, no lookup. Works the moment the API is fronted by such a CDN.
//      NOTE: today the checkout API runs on Render and is NOT behind the
//      Cloudflare proxy in front of aidfone.com, so these headers are absent —
//      which is exactly why the IP fallback below exists.
//   2. IP geolocation via `geoip-lite` (optional dependency, lazy-required so
//      the server still boots if it isn't installed). Reads the client IP from
//      the `x-forwarded-for` chain Render sets.
//
// This helper is NOT enforced anywhere yet. Wiring it into
// `/api/checkout/create-session` (block + "coming soon" response) lands with
// the finalized ticket. The read-only `GET /api/geo` endpoint (routes/geo.ts)
// lets the frontend pre-check before starting checkout.
// ---------------------------------------------------------------------------

export const ALLOWED_CHECKOUT_COUNTRIES = ['CA', 'US'] as const;
export type AllowedCountry = (typeof ALLOWED_CHECKOUT_COUNTRIES)[number];

export type CountrySource = 'header' | 'geoip' | 'unknown';

export interface GeoResult {
  /** ISO 3166-1 alpha-2, uppercased, or null when it can't be determined. */
  country: string | null;
  source: CountrySource;
  /** The client IP we resolved from, for logging/debugging. */
  ip: string | null;
}

// CDN/proxy headers that carry a 2-letter country code, in priority order.
const COUNTRY_HEADERS = [
  'cf-ipcountry', // Cloudflare
  'x-vercel-ip-country', // Vercel
  'x-country', // generic / some proxies
  'x-appengine-country', // Google App Engine
] as const;

// RFC1918 private ranges + loopback/link-local — never geolocatable, so we skip
// the IP lookup for them (e.g. local dev, internal health checks).
const PRIVATE_IP =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i;

/** Extract the client's public IP, honoring the `x-forwarded-for` chain. */
export function getClientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  let ip: string | null = null;
  if (typeof fwd === 'string' && fwd.length > 0) {
    // Left-most entry is the original client (Render appends its own hops).
    ip = fwd.split(',')[0].trim();
  } else if (Array.isArray(fwd) && fwd.length > 0) {
    ip = fwd[0].split(',')[0].trim();
  } else {
    ip = req.socket.remoteAddress ?? null;
  }
  if (!ip) return null;
  // Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) to plain IPv4.
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  return ip;
}

function normalizeCountry(value: string | undefined): string | null {
  if (!value) return null;
  const c = value.trim().toUpperCase();
  // Cloudflare returns 'XX' (unknown) and 'T1' (Tor) — treat as undetermined.
  if (c.length !== 2 || c === 'XX' || c === 'T1') return null;
  return c;
}

/** Country from a CDN/proxy header, if present (instant, no lookup). */
export function getCountryFromHeaders(req: Request): string | null {
  for (const h of COUNTRY_HEADERS) {
    const v = req.headers[h];
    const country = normalizeCountry(
      typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
    );
    if (country) return country;
  }
  // Netlify exposes geo as base64 JSON in `x-nf-geo` — handle defensively.
  const nf = req.headers['x-nf-geo'];
  if (typeof nf === 'string' && nf.length > 0) {
    try {
      const decoded = JSON.parse(Buffer.from(nf, 'base64').toString('utf8')) as {
        country?: { code?: string };
      };
      const country = normalizeCountry(decoded.country?.code);
      if (country) return country;
    } catch {
      // malformed header — ignore and fall through to IP lookup
    }
  }
  return null;
}

// Optional `geoip-lite`, kept out of the static import graph so the server runs
// even if the package (and its ~150MB DB) isn't installed — the IP path simply
// returns null until `npm i geoip-lite` is run in server/. Memoized after first
// load (including the not-installed case).
interface GeoIpLite {
  lookup(ip: string): { country?: string } | null;
}
let geoip: GeoIpLite | null | undefined;

function loadGeoip(): GeoIpLite | null {
  if (geoip !== undefined) return geoip;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    geoip = require('geoip-lite') as GeoIpLite;
  } catch {
    console.warn(
      '[geo] geoip-lite not installed — IP-based country lookup disabled. ' +
        'Run `npm i geoip-lite` in server/ to enable the US gate fallback.'
    );
    geoip = null;
  }
  return geoip;
}

/**
 * Country from an IP via geoip-lite. Returns null for private/loopback IPs or
 * when geoip-lite isn't installed.
 */
export function lookupCountryFromIp(ip: string | null): string | null {
  if (!ip || PRIVATE_IP.test(ip)) return null;
  const g = loadGeoip();
  if (!g) return null;
  return normalizeCountry(g.lookup(ip)?.country);
}

/** Full resolution: CDN header first, then IP geolocation. */
export function resolveCountry(req: Request): GeoResult {
  const ip = getClientIp(req);
  const fromHeader = getCountryFromHeaders(req);
  if (fromHeader) return { country: fromHeader, source: 'header', ip };
  const fromIp = lookupCountryFromIp(ip);
  if (fromIp) return { country: fromIp, source: 'geoip', ip };
  return { country: null, source: 'unknown', ip };
}

/** True only for an explicitly allowed country (CA/US). `null` (undetermined) is NOT allowed here — the route decides whether to fail open or closed. */
export function isCheckoutAllowed(country: string | null): boolean {
  return (
    country !== null &&
    (ALLOWED_CHECKOUT_COUNTRIES as readonly string[]).includes(country)
  );
}
