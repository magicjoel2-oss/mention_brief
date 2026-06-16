// =============================================================================
// Mention Brief - Auth PoC D2: MSAL cache extraction + dual-audience probing
// =============================================================================
// D1 confirmed:
//   - Teams web does NOT call graph.microsoft.com directly. Network sniffing
//     never catches a Graph Bearer.
//   - But localStorage has MSAL-cached tokens for both graph.microsoft.com
//     and chatsvcagg.teams.microsoft.com (Teams own backend).
//
// D2 plan:
//   1. Open teams.microsoft.com (reuse profile).
//   2. Read MSAL accesstoken cache entries from localStorage.
//   3. For each one, parse the .secret JWT.
//   4. Try a few endpoints:
//        Graph token  -> GET /me, GET /me/chats, GET /me/messages with mentions filter
//        Teams token  -> GET activity feed via chatsvcagg
//   5. Print status + a small response sample for every probe.
//
// The probe results decide the path:
//   - If Graph token covers enough for mention discovery, go through Graph.
//   - If only the Teams token works, build the digest off chatsvcagg.
// =============================================================================

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.resolve(__dirname, "..", ".browser-profile");

const LAUNCH_OPTS = {
  headless: false,
  viewport: { width: 1280, height: 900 },
  channel: "msedge",
};

console.log(`Profile dir : ${profileDir}`);
const ctx = await chromium.launchPersistentContext(profileDir, LAUNCH_OPTS);
const page = ctx.pages()[0] ?? (await ctx.newPage());

console.log("Navigating to teams.microsoft.com...");
await page.goto("https://teams.microsoft.com/", { waitUntil: "domcontentloaded" });
console.log("Waiting 20s for Teams to populate MSAL cache...");
await page.waitForTimeout(20_000);

console.log("");
console.log("==== Step 1: Extract MSAL accesstoken entries ====");

const tokens = await page.evaluate(() => {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (!k.includes("accesstoken")) continue;
    try {
      const v = JSON.parse(localStorage.getItem(k));
      if (v?.secret && typeof v.secret === "string") {
        out.push({
          key: k,
          target: v.target ?? "",
          secret: v.secret,
          expiresOn: v.expiresOn,
        });
      }
    } catch {}
  }
  return out;
});

console.log(`Found ${tokens.length} accesstoken entries.`);

function pickToken(needle) {
  return tokens.find((t) => t.target.toLowerCase().includes(needle.toLowerCase()));
}

const graphTok = pickToken("graph.microsoft.com");
const teamsTok = pickToken("chatsvcagg.teams.microsoft.com");

console.log(`  Graph token        : ${graphTok ? "yes (" + graphTok.secret.length + " chars)" : "NO"}`);
console.log(`  chatsvcagg token   : ${teamsTok ? "yes (" + teamsTok.secret.length + " chars)" : "NO"}`);
if (graphTok) {
  const scopes = (graphTok.target || "").split(" ").filter((s) => s.startsWith("https://graph.microsoft.com/")).map(s => s.replace("https://graph.microsoft.com/", ""));
  console.log(`  Graph scopes (${scopes.length}): ${scopes.join(", ").slice(0, 400)}`);
}

async function probe(label, url, token, init = {}) {
  console.log("");
  console.log(`---- ${label} ----`);
  console.log(`  ${init.method ?? "GET"} ${url}`);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    console.log(`  status: ${res.status}`);
    console.log(`  body  : ${text.slice(0, 400)}`);
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    console.log(`  ERR: ${e.message}`);
    return { ok: false, status: 0, text: e.message };
  }
}

if (graphTok) {
  console.log("");
  console.log("==== Step 2: Graph token probes ====");
  await probe("/me", "https://graph.microsoft.com/v1.0/me", graphTok.secret);
  await probe("/me/chats?$top=3", "https://graph.microsoft.com/v1.0/me/chats?$top=3", graphTok.secret);
  await probe(
    "/me/chats/getAllMessages?$top=3",
    "https://graph.microsoft.com/v1.0/me/chats/getAllMessages?$top=3",
    graphTok.secret
  );
  await probe(
    "POST /search/query (chatMessage, mentions:magicjoel)",
    "https://graph.microsoft.com/v1.0/search/query",
    graphTok.secret,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            entityTypes: ["chatMessage"],
            query: { queryString: "mentions:magicjoel" },
            from: 0,
            size: 3,
          },
        ],
      }),
    }
  );
}

if (teamsTok) {
  console.log("");
  console.log("==== Step 3: chatsvcagg token probes ====");
  // Teams' own backend; these endpoints are reverse-engineered from teams web traffic.
  await probe(
    "Teams self profile",
    "https://chatsvcagg.teams.microsoft.com/api/v2/users/me",
    teamsTok.secret
  );
  await probe(
    "Teams chats list",
    "https://chatsvcagg.teams.microsoft.com/api/v2/users/me/chats?pageSize=3",
    teamsTok.secret
  );
  await probe(
    "Teams activity feed",
    "https://chatsvcagg.teams.microsoft.com/api/v2/users/me/activitiesFeed?pageSize=10",
    teamsTok.secret
  );
}

console.log("");
console.log("==== Done. Closing browser. ====");
await ctx.close();
console.log("Paste this whole output back to Claude Code.");
