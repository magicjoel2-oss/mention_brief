// =============================================================================
// Mention Brief - Auth PoC D: Teams web session token interception
// =============================================================================
// Reuses .browser-profile (created by setup-browser.mjs) to launch Chromium,
// loads teams.microsoft.com, and intercepts outgoing Graph requests to capture
// a Bearer token. If captured, calls /me and /me/chats to verify the token
// works for our own API calls.
//
//   PS> npm run poc-d
//
// On failure, the script prints what URLs were observed and what
// Authorization headers (if any) were seen. That guides next steps.
// =============================================================================

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.resolve(__dirname, "..", ".browser-profile");

const LAUNCH_OPTS = {
  headless: false, // first PoC keep visible so you can see what is happening
  viewport: { width: 1280, height: 900 },
  // Bundled Chromium download blocked by corporate SSL interception ->
  // use the system Edge that is already installed on this PC.
  channel: "msedge",
};

console.log(`Profile dir : ${profileDir}`);
console.log("Launching Chromium (visible window for first PoC)...");

const ctx = await chromium.launchPersistentContext(profileDir, LAUNCH_OPTS);

const tokensByAudience = new Map(); // hostname -> {token, sampleUrl}
const observedAuthHosts = new Set();

ctx.on("request", (req) => {
  const url = req.url();
  const auth = req.headers()["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return;
  try {
    const host = new URL(url).hostname;
    observedAuthHosts.add(host);
    if (!tokensByAudience.has(host)) {
      tokensByAudience.set(host, { token: auth, sampleUrl: url });
    }
  } catch {}
});

const page = ctx.pages()[0] ?? (await ctx.newPage());

console.log("Navigating to teams.microsoft.com...");
await page.goto("https://teams.microsoft.com/", { waitUntil: "domcontentloaded" });

console.log("Waiting up to 90s for Teams to issue authenticated requests...");
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  if (tokensByAudience.has("graph.microsoft.com")) break;
  await page.waitForTimeout(2_000);
}

console.log("");
console.log("==== Observed authenticated hosts ====");
for (const h of observedAuthHosts) console.log(`  - ${h}`);

const graphEntry = tokensByAudience.get("graph.microsoft.com");

if (!graphEntry) {
  console.error("");
  console.error("[FAIL] No Bearer token directed at graph.microsoft.com was seen.");
  console.error("Possible reasons:");
  console.error("  - Teams web routes through chatsvcagg.teams.microsoft.com instead.");
  console.error("    Inspect the list above and choose a different audience host.");
  console.error("  - Session expired -> rerun setup-browser.mjs.");
  console.error("  - MFA re-prompt is pending -> rerun setup-browser.mjs (non-headless).");

  // Try a fallback: inspect localStorage / sessionStorage for cached Graph tokens
  console.error("");
  console.error("Probing in-page storage for cached tokens...");
  const storageProbe = await page.evaluate(() => {
    const findGraphLike = (storage) => {
      const out = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k) continue;
        if (k.toLowerCase().includes("graph") || k.toLowerCase().includes("accesstoken") || k.includes("login.microsoftonline.com")) {
          const v = storage.getItem(k) ?? "";
          out.push({ k, len: v.length, preview: v.slice(0, 80) });
        }
      }
      return out;
    };
    return {
      local: findGraphLike(localStorage),
      session: findGraphLike(sessionStorage),
    };
  });
  console.error(JSON.stringify(storageProbe, null, 2));

  await ctx.close();
  process.exit(2);
}

console.log("");
console.log(`[OK] Captured Graph Bearer token from: ${graphEntry.sampleUrl.slice(0, 90)}`);

const tokenLen = graphEntry.token.length - "Bearer ".length;
console.log(`     token length: ${tokenLen} chars`);

console.log("");
console.log("==== Testing token: GET /me ====");
const meRes = await fetch("https://graph.microsoft.com/v1.0/me", {
  headers: { Authorization: graphEntry.token },
});
console.log(`  status: ${meRes.status}`);
if (meRes.ok) {
  const me = await meRes.json();
  console.log(`  displayName : ${me.displayName}`);
  console.log(`  upn         : ${me.userPrincipalName}`);
  console.log(`  id          : ${me.id}`);
} else {
  console.error(`  body: ${(await meRes.text()).slice(0, 400)}`);
}

console.log("");
console.log("==== Testing token: GET /me/chats?$top=3 ====");
const chatsRes = await fetch("https://graph.microsoft.com/v1.0/me/chats?$top=3&$orderby=lastUpdatedDateTime desc", {
  headers: { Authorization: graphEntry.token },
});
console.log(`  status: ${chatsRes.status}`);
if (chatsRes.ok) {
  const { value } = await chatsRes.json();
  console.log(`  ${value.length} chats:`);
  for (const c of value) {
    const label = c.topic ?? `(${c.chatType})`;
    console.log(`    - ${label}  [${c.id.slice(0, 40)}...]`);
  }
} else {
  console.error(`  body: ${(await chatsRes.text()).slice(0, 400)}`);
}

console.log("");
console.log("==== Testing token: POST /search/query (mentions:magicjoel) ====");
const searchRes = await fetch("https://graph.microsoft.com/v1.0/search/query", {
  method: "POST",
  headers: {
    Authorization: graphEntry.token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    requests: [
      {
        entityTypes: ["chatMessage"],
        query: { queryString: "mentions:magicjoel" },
        from: 0,
        size: 5,
      },
    ],
  }),
});
console.log(`  status: ${searchRes.status}`);
if (searchRes.ok) {
  const data = await searchRes.json();
  const hits = data.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
  console.log(`  ${hits.length} hits`);
  for (const h of hits) {
    console.log(`    - ${(h.summary ?? "").slice(0, 100)}`);
  }
} else {
  console.error(`  body: ${(await searchRes.text()).slice(0, 400)}`);
}

console.log("");
console.log("Closing browser...");
await ctx.close();
console.log("Done. Paste this entire output back to Claude Code.");
