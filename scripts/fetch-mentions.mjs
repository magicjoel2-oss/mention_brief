// =============================================================================
// Mention Brief - Step 1: fetch raw 24h messages for known chats and find
// mention candidates.
//
// What it does:
//   1. Launch Edge with the saved profile.
//   2. Pull the ic3.teams.office.com access token from MSAL cache.
//   3. Fire two probes in parallel:
//        a. GET /api/csa/apac/api/v3/teams/users/me/updates (chat list hint)
//        b. for each chatId in data/chat-labels.json: GET messages?startTime=24h
//   4. Scan every message: if its HTML body contains a Skype Mention span,
//      flag it as a mention candidate.
//   5. Print a compact summary and dump full raw responses to
//      .browser-profile/_step1-fetch.json for offline review.
//
// Goal: with this dump in hand we can confirm
//   - exactly how the userId of a mention is identified
//     (probably via the message's `properties` field, JSON-encoded inside content)
//   - whether me/updates yields a chat list or we stay with chat-labels.
// =============================================================================

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.resolve(__dirname, "..", ".browser-profile");
const dataDir = path.resolve(__dirname, "..", "data");

const MY_ID = "2185dfaa-243b-4541-ba33-1f223e81ccf9";

const LAUNCH_OPTS = {
  headless: false, // keep visible for first run; flip to true once stable
  viewport: { width: 1280, height: 900 },
  channel: "msedge",
};

// ---- 1. read chat-labels seed ----
const labelsRaw = await fs.readFile(path.join(dataDir, "chat-labels.json"), "utf8");
const chatLabels = JSON.parse(labelsRaw);
const seedChatIds = Object.keys(chatLabels);
console.log(`Seed chats (from data/chat-labels.json): ${seedChatIds.length}`);

const ctx = await chromium.launchPersistentContext(profileDir, LAUNCH_OPTS);
const page = ctx.pages()[0] ?? (await ctx.newPage());

console.log("Loading teams.microsoft.com...");
await page.goto("https://teams.microsoft.com/", { waitUntil: "domcontentloaded" });
console.log("Waiting 25s for Teams to populate MSAL cache...");
await page.waitForTimeout(25_000);

// ---- 2. extract ic3 token ----
const ic3Token = await page.evaluate(() => {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.includes("accesstoken")) continue;
    try {
      const v = JSON.parse(localStorage.getItem(k));
      if (v?.target?.includes("ic3.teams.office.com") && v?.secret) {
        return v.secret;
      }
    } catch {}
  }
  return null;
});

if (!ic3Token) {
  console.error("[FAIL] No ic3 token in MSAL cache. Run setup-browser.mjs to re-login.");
  await ctx.close();
  process.exit(1);
}
console.log(`[OK] ic3 token extracted (${ic3Token.length} chars)`);

// ---- 3. shared helpers running inside the page ----
const fetchResult = await page.evaluate(
  async ({ token, chatIds, myId }) => {
    const baseHeaders = {
      "x-ms-region": "kr",
      "x-ms-partition": "kr01",
      "x-ms-user-type": "real-user",
      "x-ms-client-type": "cdlworker",
      "x-ms-client-version": "1415/26051416715",
      "x-ms-object-id": myId,
      "cache-control": "no-store, no-cache",
      clientinfo:
        "os=windows; osVer=NT 10.0; proc=x86; lcid=ko-kr; deviceType=1; country=kr; clientName=skypeteams; clientVer=1415/26051416715; utcOffset=+09:00; timezone=Asia/Seoul",
      Authorization: `Bearer ${token}`,
    };

    const since = Date.now() - 24 * 60 * 60 * 1000;

    async function get(url) {
      const t0 = performance.now();
      try {
        const res = await fetch(url, { headers: baseHeaders });
        const ms = Math.round(performance.now() - t0);
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch { body = text; }
        return { url, status: res.status, ms, body, textLen: text.length };
      } catch (e) {
        return { url, status: 0, error: String(e) };
      }
    }

    // 3a. me/updates - hint for chat enumeration
    const updates = await get(
      "/api/csa/apac/api/v3/teams/users/me/updates?isPrefetch=false&enableMembershipSummary=true&supportsAdditionalSystemGeneratedFolders=true&supportsSliceItems=true&enableEngageCommunities=false"
    );

    // 3b. messages per known chat (sequential to avoid rate-limit surprises)
    const perChat = [];
    for (const chatId of chatIds) {
      const enc = encodeURIComponent(chatId);
      const r = await get(
        `/api/chatsvc/kr/v1/users/ME/conversations/${enc}/messages?view=msnp24Equivalent|supportsMessageProperties&pageSize=200&startTime=${since}`
      );
      perChat.push({ chatId, ...r });
    }

    return { since, updates, perChat };
  },
  { token: ic3Token, chatIds: seedChatIds, myId: MY_ID }
);

await ctx.close();

// ---- 4. analyze ----
console.log("");
console.log(`==== /me/updates ====`);
console.log(`  status=${fetchResult.updates.status} bytes=${fetchResult.updates.textLen}`);
if (typeof fetchResult.updates.body === "object" && fetchResult.updates.body) {
  console.log(`  top-level keys: ${Object.keys(fetchResult.updates.body).join(", ")}`);
}

console.log("");
console.log(`==== Per-chat fetch (24h window from ${new Date(fetchResult.since).toISOString()}) ====`);

const MENTION_RE = /itemtype=["']http:\/\/schema\.skype\.com\/Mention/i;
const mentionCandidates = [];

for (const r of fetchResult.perChat) {
  const label = chatLabels[r.chatId] ?? "(no-label)";
  if (r.status !== 200) {
    console.log(`  [${r.status}] ${label}  ${r.error ?? ""}`);
    continue;
  }
  const msgs = r.body?.messages ?? [];
  // newest 24h count
  const mentionsHere = msgs.filter((m) => {
    const c = m?.content ?? "";
    return MENTION_RE.test(c);
  });
  // filter: not authored by me, and contains a mention span
  const incoming = mentionsHere.filter((m) => {
    const fromMri = (m?.from || "").toString();
    return !fromMri.includes(MY_ID);
  });
  console.log(`  [200] ${label.padEnd(25)} msgs=${String(msgs.length).padStart(3)}  withMention=${mentionsHere.length}  incoming=${incoming.length}`);
  for (const m of incoming) {
    mentionCandidates.push({
      chatId: r.chatId,
      chatLabel: label,
      messageId: m.id,
      from: m.from,
      fromDisplay: m.imdisplayname || m.fromDisplayNameInToken,
      composeTime: m.composetime ?? m.originalarrivaltime,
      contentType: m.contenttype,
      content: m.content,
      properties: m.properties,
      messageProperties: m.messageProperties,
    });
  }
}

console.log("");
console.log(`==== Mention candidates found: ${mentionCandidates.length} ====`);
for (const c of mentionCandidates.slice(0, 5)) {
  console.log("");
  console.log(`  [${c.chatLabel}] ${c.composeTime}  from=${c.fromDisplay}`);
  console.log(`    messageId=${c.messageId}`);
  console.log(`    contentType=${c.contentType}`);
  console.log(`    content sample: ${String(c.content).slice(0, 220).replace(/\s+/g, " ")}`);
  if (c.properties) {
    console.log(`    properties keys: ${Object.keys(c.properties).join(", ")}`);
    if (c.properties.mentions) {
      console.log(`    properties.mentions sample: ${String(c.properties.mentions).slice(0, 300)}`);
    }
  }
  if (c.messageProperties) {
    console.log(`    messageProperties keys: ${Object.keys(c.messageProperties).join(", ")}`);
  }
}
if (mentionCandidates.length > 5) {
  console.log(`  ... (${mentionCandidates.length - 5} more)`);
}

// ---- 5. dump full raw to file ----
const dumpFile = path.join(profileDir, "_step1-fetch.json");
await fs.writeFile(dumpFile, JSON.stringify(fetchResult, null, 2), "utf8");
console.log("");
console.log(`Full raw responses -> ${dumpFile} (gitignored)`);
console.log("");
console.log("Next: paste console output back to Claude Code; review the");
console.log("'properties.mentions' field shape to finalize the mention filter.");
