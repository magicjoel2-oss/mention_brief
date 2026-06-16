// =============================================================================
// Mention Brief - Auth PoC D4: confirm chat-list endpoint + mention structure
// =============================================================================
// D3 confirmed:
//   - Teams web hits /api/chatsvc/kr/v1/.../messages with Bearer auth.
//   - Mentions appear inside HTML body as
//       <span itemtype="http://schema.skype.com/Mention" itemid="N">name</span>
//
// Remaining unknowns:
//   - How to enumerate the user's chats (Teams web obviously has the list
//     but D3 capture didn't surface the endpoint).
//   - Where the userId for each mention (itemid=N) lives in the response.
//
// Strategy:
//   Instead of intercepting traffic, run fetch() FROM INSIDE the page via
//   page.evaluate(). Teams' MSAL layer auto-attaches the right Bearer/headers,
//   so this works without knowing the token audience.
//
//   We probe several candidate chat-list endpoints and one full message detail
//   to inspect the mention structure.
// =============================================================================

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.resolve(__dirname, "..", ".browser-profile");
const outDir = path.resolve(__dirname, "..", ".browser-profile");

const LAUNCH_OPTS = {
  headless: false,
  viewport: { width: 1280, height: 900 },
  channel: "msedge",
};

const ctx = await chromium.launchPersistentContext(profileDir, LAUNCH_OPTS);
const page = ctx.pages()[0] ?? (await ctx.newPage());

console.log("Loading teams.microsoft.com...");
await page.goto("https://teams.microsoft.com/", { waitUntil: "domcontentloaded" });
console.log("Waiting 25s for Teams to fully boot (MSAL init + worker startup)...");
await page.waitForTimeout(25_000);

// --- Run all probes inside the page so MSAL adds Bearer headers automatically ---
const probeResult = await page.evaluate(async () => {
  const out = { probes: [], notes: [] };

  async function call(label, url, init = {}) {
    const start = performance.now();
    try {
      const res = await fetch(url, { credentials: "include", ...init });
      const ms = Math.round(performance.now() - start);
      const ct = res.headers.get("content-type") || "";
      const text = await res.text();
      out.probes.push({
        label,
        url,
        method: init.method || "GET",
        status: res.status,
        contentType: ct,
        ms,
        bodyLength: text.length,
        bodyPreview: text.slice(0, 1500),
        bodyFull: text.length < 60_000 ? text : null,
      });
    } catch (e) {
      out.probes.push({ label, url, status: 0, error: String(e) });
    }
  }

  // ---- Chat-list candidates (from open-source Teams reverse-engineering notes) ----
  await call(
    "v3 updates",
    "/api/csa/apac/api/v3/teams/users/me/updates?isPrefetch=false&enableMembershipSummary=true&supportsAdditionalSystemGeneratedFolders=true&supportsSliceItems=true&enableEngageCommunities=false"
  );
  await call(
    "v3 chatThreads",
    "/api/csa/apac/api/v3/teams/users/me/chatThreads?pageSize=50&isPrefetch=false"
  );
  await call(
    "v2 chats",
    "/api/csa/apac/api/v2/teams/users/me/chats?pageSize=50"
  );
  await call(
    "v1 conversations",
    "/api/csa/apac/api/v1/teams/users/me/conversations?pageSize=50"
  );
  await call(
    "chatsvc threads",
    "/api/chatsvc/kr/v1/users/ME/conversations?pageSize=50"
  );
  await call(
    "chatsvc properties only",
    "/api/chatsvc/kr/v1/users/ME/properties"
  );

  // ---- Activity / mention candidates ----
  await call(
    "v3 alerts",
    "/api/csa/apac/api/v3/teams/users/me/alerts?pageSize=20"
  );
  await call(
    "v3 activityFeed",
    "/api/csa/apac/api/v3/teams/users/me/activityFeed?pageSize=20"
  );
  await call(
    "v2 mentions",
    "/api/csa/apac/api/v2/teams/users/me/mentions?pageSize=20"
  );

  // ---- One known group chat (the "쇼츠 작업방" from spec): fetch 24h messages,
  //      and if any message looks like a mention to us, fetch its full detail. ----
  const KNOWN_CHAT = "19:52ae7b283c4f4f6ca934b49f415a18b5@thread.v2";
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const enc = encodeURIComponent(KNOWN_CHAT);
  await call(
    "chatsvc messages (known chat 24h)",
    `/api/chatsvc/kr/v1/users/ME/conversations/${enc}/messages?view=msnp24Equivalent|supportsMessageProperties&pageSize=200&startTime=${since}`
  );
  // ---- Fetch one specific message we already saw in capture, expecting mentions in detail ----
  const KNOWN_MSG_CHAT = "19:42acef2915894b20bdd4e2ed6c19ba95@thread.v2";
  const KNOWN_MSG_ID = "1772703412565";
  await call(
    "chatsvc message detail",
    `/api/chatsvc/kr/v1/users/ME/conversations/${encodeURIComponent(KNOWN_MSG_CHAT)}/messages/${KNOWN_MSG_ID}?view=msnp24Equivalent|supportsMessageProperties`
  );

  return out;
});

// --- Print compact summary to console ---
console.log("");
console.log("==== Probe summary ====");
for (const p of probeResult.probes) {
  const tag = p.status >= 200 && p.status < 300 ? "[OK]" : `[${p.status}]`;
  console.log(`${tag.padEnd(7)} ${String(p.ms || "").padStart(4)}ms  ${p.bodyLength || 0}b  ${p.label}`);
  if (p.error) console.log(`         ERR: ${p.error}`);
}

// --- Save full results to file for analysis ---
const outFile = path.resolve(outDir, "_d4-probes.json");
await fs.writeFile(outFile, JSON.stringify(probeResult, null, 2), "utf8");
console.log("");
console.log(`Full probe responses -> ${outFile}`);

// --- Print which chat-list candidates returned 200 with chat-like body ---
console.log("");
console.log("==== Chat-list candidates that returned 200 ====");
for (const p of probeResult.probes) {
  if (p.status !== 200) continue;
  const hint = (p.bodyPreview || "").slice(0, 250).replace(/\s+/g, " ");
  console.log(`  ${p.label}`);
  console.log(`    preview: ${hint}`);
}

// --- Show preview of message detail to locate the mention metadata field ---
const detail = probeResult.probes.find((p) => p.label === "chatsvc message detail" && p.status === 200);
if (detail && detail.bodyFull) {
  console.log("");
  console.log("==== Full message-detail response (mentions structure search) ====");
  // Look for the substring around 'mentions' / 'properties' to spot field shape
  const body = detail.bodyFull;
  const hints = ["properties", "mentions", "messageProperties", "skypemention", "Mention"];
  for (const h of hints) {
    const i = body.toLowerCase().indexOf(h.toLowerCase());
    if (i >= 0) {
      const start = Math.max(0, i - 80);
      const end = Math.min(body.length, i + 300);
      console.log(`  found "${h}" at offset ${i}:`);
      console.log(`    ...${body.slice(start, end).replace(/\s+/g, " ")}...`);
    } else {
      console.log(`  "${h}" not found`);
    }
  }
}

await ctx.close();
console.log("");
console.log("Done. Paste console output back to Claude Code.");
