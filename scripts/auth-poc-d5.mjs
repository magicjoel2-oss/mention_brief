// =============================================================================
// Mention Brief - Auth PoC D5: pick the right token audience for chatsvc
// =============================================================================
// D4 result: page.evaluate fetch returns 401 because Teams' MSAL wrapper does
// NOT auto-attach a Bearer to plain fetch().
// We must extract a token from MSAL cache and inject the right headers.
//
// Plan:
//   1. Read every accesstoken entry from localStorage.
//   2. For each, try a known chatsvc messages call. The first one that
//      returns 200 reveals the right audience + token shape for automation.
//   3. The full headers (incl. x-ms-region, x-ms-partition, clientinfo)
//      come from the D3 capture, so any of them that matter are covered.
// =============================================================================

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.resolve(__dirname, "..", ".browser-profile");

const LAUNCH_OPTS = {
  headless: false,
  viewport: { width: 1280, height: 900 },
  channel: "msedge",
};

const ctx = await chromium.launchPersistentContext(profileDir, LAUNCH_OPTS);
const page = ctx.pages()[0] ?? (await ctx.newPage());

console.log("Loading teams.microsoft.com...");
await page.goto("https://teams.microsoft.com/", { waitUntil: "domcontentloaded" });
console.log("Waiting 25s for Teams to populate MSAL cache...");
await page.waitForTimeout(25_000);

const result = await page.evaluate(async () => {
  // ---- collect all access tokens ----
  const tokens = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.includes("accesstoken")) continue;
    try {
      const v = JSON.parse(localStorage.getItem(k));
      if (v?.secret) {
        tokens.push({
          target: (v.target || "").slice(0, 250),
          secret: v.secret,
          secretLen: v.secret.length,
          expiresOn: v.expiresOn,
        });
      }
    } catch {}
  }

  // ---- known endpoint to test: list 24h messages from one chat from spec ----
  const KNOWN_CHAT = "19:52ae7b283c4f4f6ca934b49f415a18b5@thread.v2"; // 쇼츠 작업방
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const enc = encodeURIComponent(KNOWN_CHAT);
  const url = `/api/chatsvc/kr/v1/users/ME/conversations/${enc}/messages?view=msnp24Equivalent|supportsMessageProperties&pageSize=3&startTime=${since}`;

  // Headers copied from D3 capture so we match Teams web exactly
  const baseHeaders = {
    "x-ms-region": "kr",
    "x-ms-partition": "kr01",
    "x-ms-user-type": "real-user",
    "x-ms-client-type": "cdlworker",
    "x-ms-client-version": "1415/26051416715",
    "x-ms-object-id": "2185dfaa-243b-4541-ba33-1f223e81ccf9",
    "cache-control": "no-store, no-cache",
    "clientinfo":
      "os=windows; osVer=NT 10.0; proc=x86; lcid=ko-kr; deviceType=1; country=kr; clientName=skypeteams; clientVer=1415/26051416715; utcOffset=+09:00; timezone=Asia/Seoul",
  };

  const attempts = [];
  for (const t of tokens) {
    let status = 0,
      bodyPreview = "",
      err = null;
    try {
      const res = await fetch(url, {
        headers: { ...baseHeaders, Authorization: `Bearer ${t.secret}` },
      });
      status = res.status;
      const text = await res.text();
      bodyPreview = text.slice(0, 300);
    } catch (e) {
      err = String(e);
    }
    attempts.push({
      target: t.target,
      secretLen: t.secretLen,
      expiresOn: t.expiresOn,
      status,
      bodyPreview,
      err,
    });
  }

  return { url, tokenCount: tokens.length, attempts };
});

console.log("");
console.log(`Probed ${result.tokenCount} tokens against:`);
console.log(`  ${result.url}`);
console.log("");

// Print short audience tag for each, sorted by status (200 first)
const sorted = [...result.attempts].sort((a, b) => {
  const sa = a.status === 200 ? 0 : a.status === 401 ? 2 : 1;
  const sb = b.status === 200 ? 0 : b.status === 401 ? 2 : 1;
  return sa - sb;
});

for (const a of sorted) {
  const tag =
    a.status === 200 ? "[ 200 ]" : a.status === 401 ? "[ 401 ]" : a.status ? `[ ${a.status} ]` : "[ ERR ]";
  // pull a short audience hint
  const aud =
    a.target
      .split(" ")
      .find((s) => s.includes("://") && !s.endsWith("/.default")) ||
    a.target.split(" ")[0] ||
    "(unknown)";
  console.log(`${tag} aud=${aud.slice(0, 80)}   sec=${a.secretLen}c`);
  if (a.status === 200) {
    console.log(`        BODY: ${a.bodyPreview.replace(/\s+/g, " ").slice(0, 200)}`);
  } else if (a.status && a.status !== 401) {
    console.log(`        BODY: ${a.bodyPreview.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

// Save full results
const outFile = path.resolve(profileDir, "_d5-tokens.json");
await fs.writeFile(outFile, JSON.stringify(result, null, 2), "utf8");
console.log("");
console.log(`Full result -> ${outFile}`);

await ctx.close();
console.log("Done.");
