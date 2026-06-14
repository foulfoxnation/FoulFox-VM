import https from "https";
import crypto from "crypto";

// ── Microsoft consumer ISO resolver ──────────────────────────────────────────
// Resolves an official, time-limited Windows ISO download URL from Microsoft's
// public "software download connector" API — the same flow the Edge/Chrome
// download page uses when a non-Windows browser is detected. No third-party
// mirrors, no vendored shell scripts.
//
// This endpoint is a moving target and Microsoft actively rate-limits/blocks
// datacenter networks, so callers MUST treat failure as expected and fall back
// to the USB "frontload" path. We surface clean, human-readable errors.

const PROFILE = "606624d44113";
const ORG_ID = "y6jn8c31";
// A desktop browser UA + referer are required or Microsoft returns an empty/blocked response.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface Sku {
  Id: string;
  Language?: string;
  LocalizedLanguage?: string;
}

interface DownloadOption {
  Uri?: string;
  DownloadType?: number;
}

function get(url: string, accept: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": UA,
          Accept: accept,
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.microsoft.com/software-download/windows11",
        },
        timeout: 30000,
      },
      (res) => {
        // Follow redirects (rare on these JSON endpoints, but be safe).
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          get(res.headers.location, accept).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Microsoft returned HTTP ${res.statusCode}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Microsoft request timed out")));
    req.on("error", reject);
  });
}

async function getJson(url: string): Promise<unknown> {
  const text = await get(url, "application/json, text/javascript, */*; q=0.01");
  try {
    return JSON.parse(text);
  } catch {
    // When blocked, Microsoft returns an HTML error page instead of JSON.
    throw new Error("Microsoft did not return a valid response (the download service is likely blocking this network).");
  }
}

function pickEnglishSku(skus: Sku[]): Sku | undefined {
  const lang = (s: Sku) => (s.LocalizedLanguage || s.Language || "").toLowerCase();
  return (
    skus.find((s) => lang(s).includes("english (united states)")) ??
    skus.find((s) => lang(s).includes("english international")) ??
    skus.find((s) => lang(s).includes("english")) ??
    skus[0]
  );
}

function pickX64Iso(options: DownloadOption[]): string | undefined {
  const isos = options.filter((o) => o.Uri && /\.iso(\?|$)/i.test(o.Uri));
  return (isos.find((o) => /x64|amd64/i.test(o.Uri!)) ?? isos[0])?.Uri;
}

async function resolveOnce(productEditionId: string): Promise<string> {
  const sessionId = crypto.randomUUID();

  // 1. Register the session (best effort — failure here is non-fatal).
  await get(`https://vlscppe.microsoft.com/tags?org_id=${ORG_ID}&session_id=${sessionId}`, "*/*").catch(() => "");

  // 2. Edition -> SKUs (languages).
  const skuInfo = (await getJson(
    `https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition` +
      `?profile=${PROFILE}&ProductEditionId=${encodeURIComponent(productEditionId)}` +
      `&SKU=undefined&friendlyFileName=undefined&Locale=en-US&sessionID=${sessionId}`,
  )) as { Skus?: Sku[]; skus?: Sku[] };
  const skus = skuInfo.Skus ?? skuInfo.skus ?? [];
  if (!skus.length) {
    throw new Error("Microsoft returned no Windows editions (the download service may be blocking this network).");
  }
  const sku = pickEnglishSku(skus);
  if (!sku?.Id) throw new Error("Could not select a Windows edition from Microsoft's response.");

  // 3. SKU -> download links.
  const links = (await getJson(
    `https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku` +
      `?profile=${PROFILE}&ProductEditionId=undefined&SKU=${encodeURIComponent(sku.Id)}` +
      `&friendlyFileName=undefined&Locale=en-US&sessionID=${sessionId}`,
  )) as { ProductDownloadOptions?: DownloadOption[]; Errors?: unknown[] };

  if (Array.isArray(links.Errors) && links.Errors.length) {
    throw new Error("Microsoft refused the download request (commonly a temporary block on datacenter networks).");
  }
  const uri = pickX64Iso(links.ProductDownloadOptions ?? []);
  if (!uri) throw new Error("Microsoft did not return a downloadable x64 ISO link.");
  assertMicrosoftUrl(uri);
  return uri;
}

// Defense in depth: the URL comes from Microsoft's own API, but verify it is
// HTTPS and points at a Microsoft-controlled host before handing it to the
// downloader, so a spoofed/compromised response can't redirect the multi-GB
// fetch to an attacker-controlled host (SSRF / malicious media). A false
// rejection here is safe — the caller falls back to the USB frontload path.
function assertMicrosoftUrl(uri: string): void {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new Error("Microsoft returned a malformed download URL.");
  }
  const trusted = /(^|\.)microsoft\.com$/i.test(u.hostname);
  if (u.protocol !== "https:" || !trusted) {
    throw new Error("Microsoft returned an unexpected download host; refusing it for safety.");
  }
}

// Resolve the official Windows ISO download URL for a given Microsoft
// ProductEditionId, retrying briefly on transient failures. Throws a clean
// Error (suitable for showing the user) when resolution is not possible.
export async function resolveWindowsIso(productEditionId: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await resolveOnce(productEditionId);
    } catch (err) {
      lastErr = err;
      // brief backoff between attempts
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
