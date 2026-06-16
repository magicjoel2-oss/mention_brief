// =============================================================================
// Mention Brief - Auth PoC D3: Capture the real "mentions" backend endpoint
// =============================================================================
// D2 confirmed Graph is blocked (no Chat.Read scope) and the chatsvcagg URL
// shape I guessed was wrong.
//
// D3 plan: let Teams web load its Activity feed and record every backend
// response that contains either the user id (2185dfaa-...) or the substring
// "mention". The first match is the endpoint we need to reuse.
//
// Operator action:
//   1. Browser opens to teams.microsoft.com.
//   2. CLICK the Activity tab (the bell icon, top-left sidebar).
//   3. Optionally click "Mentions" sub-filter if visible.
//   4. Wait — the script captures for 90 seconds, then closes itself.
// =============================================================================

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.resolve(__dirname, "..", ".browser-profile");

const MY_ID = "2185dfaa-243b-4541-ba33-1f223e81ccf9";

const LAUNCH_OPTS = {
  headless: false,
  viewport: { width: 1280, height: 900 },
  channel: "msedge",
};

const ctx = await chromium.launchPersistentContext(profileDir, LAUNCH_OPTS);
const page = ctx.pages()[0] ?? (await ctx.newPage());

const captures = [];
const reqIndex = new Map();

ctx.on("request", (req) => {
  reqIndex.set(req, {
    method: req.method(),
    url: req.url(),
    headers: req.headers(),
    postData: req.postData() ?? null,
  });
});

ctx.on("response", async (res) => {
  const req = res.request();
  const url = res.url();
  // Only look at backends that could plausibly serve activity/mention data
  if (!/teams\.microsoft\.com|chatsvcagg|asyncgw|substrate|outlook\.office\.com|loki\.delve|webshell/i.test(url)) {
    return;
  }
  const status = res.status();
  if (status >= 400 || status === 204) return;

  const ct = (res.headers()["content-type"] || "").toLowerCase();
  if (!ct.includes("json") && !ct.includes("text")) return;

  let body;
  try {
    body = await res.text();
  } catch {
    return;
  }
  if (!body) return;

  const hasMyId = body.includes(MY_ID);
  const hasMention = /mention/i.test(body);
  if (!hasMyId && !hasMention) return;

  const info = reqIndex.get(req) ?? { method: req.method(), url, headers: req.headers(), postData: null };
  // Strip authorization header for printing
  const safeHeaders = Object.fromEntries(
    Object.entries(info.headers).map(([k, v]) =>
      /^authorization$/i.test(k) ? [k, "Bearer <redacted, " + (v.length - 7) + " chars>"] : [k, v]
    )
  );

  captures.push({
    url: info.url,
    method: info.method,
    status,
    contentType: ct,
    hasMyId,
    hasMention,
    requestHeaders: safeHeaders,
    requestBodyPreview: info.postData ? info.postData.slice(0, 400) : null,
    responseBodyPreview: body.slice(0, 800),
    responseBodyLength: body.length,
  });
});

console.log("Navigating to teams.microsoft.com...");
await page.goto("https://teams.microsoft.com/", { waitUntil: "domcontentloaded" });

console.log("");
console.log("============================================================");
console.log(" ACTION REQUIRED (within 90 seconds)");
console.log(" 1. Click the ACTIVITY tab (bell icon, top of left sidebar)");
console.log(" 2. If a 'Mentions' sub-filter appears, click it");
console.log(" 3. Wait — script captures for 90s then closes automatically");
console.log("============================================================");
console.log("");

await page.waitForTimeout(90_000);

console.log("");
console.log(`==== Captures: ${captures.length} responses with mention-like content ====`);

// Group by hostname for readability
const byHost = new Map();
for (const c of captures) {
  let host = "?";
  try { host = new URL(c.url).hostname; } catch {}
  if (!byHost.has(host)) byHost.set(host, []);
  byHost.get(host).push(c);
}

for (const [host, list] of byHost) {
  console.log("");
  console.log(`### ${host}  (${list.length} hits)`);
  // dedupe by path (cut off query) and pick the first sample of each
  const seenPath = new Set();
  for (const c of list) {
    let pathOnly = c.url;
    try { pathOnly = new URL(c.url).pathname; } catch {}
    if (seenPath.has(pathOnly)) continue;
    seenPath.add(pathOnly);

    console.log("");
    console.log(`  ${c.method} ${c.url.slice(0, 200)}`);
    console.log(`  status=${c.status} ctype=${c.contentType.split(";")[0]} body=${c.responseBodyLength}b  myId=${c.hasMyId} mention=${c.hasMention}`);
    if (c.requestBodyPreview) {
      console.log(`  req.body: ${c.requestBodyPreview.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    console.log(`  resp.preview: ${c.responseBodyPreview.replace(/\s+/g, " ").slice(0, 400)}`);
  }
}

// Save full captures for offline review
const outFile = path.resolve(__dirname, "..", ".browser-profile", "_d3-capture.json");
const fs = await import("node:fs/promises");
await fs.writeFile(outFile, JSON.stringify(captures, null, 2), "utf8");
console.log("");
console.log(`Full capture saved -> ${outFile}`);
console.log("(this file is gitignored)");

await ctx.close();
console.log("Done.");
