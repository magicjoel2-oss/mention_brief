// =============================================================================
// Mention Brief - daily digest generator
//
// Flow (mirrors automation-spec.md section 4):
//   1. Read data/chat-labels.json for the seed chat list.
//   2. Launch Edge (.browser-profile from setup-browser.mjs), open Teams web,
//      pull the ic3.teams.office.com access token from MSAL localStorage.
//   3. For each chat, fetch /api/chatsvc/kr/v1/.../messages with a 24h window.
//   4. Keep messages whose properties.mentions contain either
//      mri="8:orgid:<MY_ID>" (direct) or mentionType="everyone" (cc).
//   5. Drop messages authored by me. Dedup against the previous day's digest
//      using Teams messageId.
//   6. Build digest items in the schema documented in automation-spec.md.
//   7. (optional) Call Anthropic for summary/recommend/priority.
//   8. Write data/YYYY-MM-DD.json + update data/index.json.
//   9. (optional) git add/commit/push.
//
// Flags:
//   --dry-run    Print the digest to stdout, write nothing, don't commit.
//   --no-ai      Skip Anthropic call even if ANTHROPIC_API_KEY is set.
//   --no-commit  Skip git add/commit/push.
//   --headed     Show the Edge window (default headless).
//
// Env:
//   ANTHROPIC_API_KEY    Required for AI classification.
//   ANTHROPIC_MODEL      Default: claude-sonnet-4-6
// =============================================================================

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const profileDir = path.join(rootDir, ".browser-profile");
const dataDir = path.join(rootDir, "data");

const MY_ID = "2185dfaa-243b-4541-ba33-1f223e81ccf9";
const MY_MRI = `8:orgid:${MY_ID}`;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null;

const args = parseArgv(process.argv.slice(2));

function parseArgv(argv) {
  const out = { dryRun: false, noAi: false, noCommit: false, headed: false };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-ai") out.noAi = true;
    else if (a === "--no-commit") out.noCommit = true;
    else if (a === "--headed") out.headed = true;
  }
  return out;
}

// ---- KST helpers ------------------------------------------------------------
const KST_MS = 9 * 60 * 60 * 1000;
function kstDate(d = new Date()) {
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
}
function kstDateTime(d = new Date()) {
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 16).replace("T", " ");
}
function kstIso(d = new Date()) {
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 19) + "+09:00";
}

// ---- HTML helpers -----------------------------------------------------------
function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<\/?(blockquote|p|br|div|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractLinks(html) {
  if (!html) return [];
  const out = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (/teams\.microsoft\.com|schema\.skype\.com/.test(url)) continue;
    const labelRaw = htmlToText(m[2]) || url;
    out.push({ label: labelRaw.slice(0, 80), url });
  }
  return out;
}

// ---- mention parsing --------------------------------------------------------
function getMentions(props) {
  if (!props) return [];
  let m = props.mentions;
  if (typeof m === "string") {
    try { m = JSON.parse(m); } catch { return []; }
  }
  return Array.isArray(m) ? m : [];
}

function mentionRoleForMe(msg) {
  const mentions = getMentions(msg?.properties);
  if (mentions.some((mn) => mn.mri === MY_MRI)) return "direct";
  if (mentions.some((mn) => mn.mentionType === "everyone")) return "cc";
  return null;
}

function senderDisplay(m) {
  return m.imdisplayname || m.fromDisplayNameInToken || (m.from || "").split("/").pop() || "(unknown)";
}

function authoredByMe(m) {
  return typeof m.from === "string" && m.from.includes(MY_ID);
}

// ---- heuristic fallback (used when no Anthropic key) ------------------------
function heuristicSummary(item) {
  const text = String(item.original || "").replace(/\s+/g, " ").trim();
  if (text.length <= 60) return text;
  return text.slice(0, 60).trim() + "…";
}

function heuristicPriority(item) {
  if (item.isCC) return "low";
  const text = String(item.original || "");
  if (/(곱창|식사|퇴근|커피|점심|저녁|회식|소주|간식)/.test(text)) return "casual";
  if (/(\?|부탁|회신|되나요|되는거에여|되는건가|되는지|가능한가|가능할까|어떠심|어떠세요|어떻게|드릴까요|드릴지|되나|확인 부탁)/.test(text)) return "high";
  if (/(검토|리뷰|수정|점검|체크|확인해)/.test(text)) return "medium";
  if (/(공유드립|공유드려|공유합|공유 드립|완료|배포|보고|드립니다|올렸|올려|업로드)/.test(text)) return "info";
  return "medium";
}

// ---- token + fetch ----------------------------------------------------------
async function extractIc3Token(page) {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.includes("accesstoken")) continue;
      try {
        const v = JSON.parse(localStorage.getItem(k));
        if (v?.target?.includes("ic3.teams.office.com") && v?.secret) return v.secret;
      } catch {}
    }
    return null;
  });
}

async function fetchChatMessages(page, token, chatId, sinceMs) {
  return page.evaluate(
    async ({ token, chatId, sinceMs, myId }) => {
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
      const enc = encodeURIComponent(chatId);
      const url = `/api/chatsvc/kr/v1/users/ME/conversations/${enc}/messages?view=msnp24Equivalent|supportsMessageProperties&pageSize=200&startTime=${sinceMs}`;
      const res = await fetch(url, { headers: baseHeaders });
      const text = await res.text();
      try { return { status: res.status, body: JSON.parse(text) }; }
      catch { return { status: res.status, body: { messages: [], _raw: text } }; }
    },
    { token, chatId, sinceMs, myId: MY_ID }
  );
}

// ---- Anthropic --------------------------------------------------------------
const AI_SYSTEM_PROMPT = `You are a Korean game design PM's assistant. The PM is 이민우 (magicjoel),
working at Nexon on the ER project (MMORPG).

For each Teams mention provided, output strict JSON:
{
  "summary": "한 문장 요약, 80자 이내",
  "recommend": "PM 권장 액션, 120자 이내",
  "priority": "high|medium|low|info|casual"
}

Priority rules:
- high: 직접 멘션 + 명시적 요청/질문 (응답 없으면 작업 블로킹)
- medium: 직접 멘션 + 검토/리뷰 요청 (시간 가용 시 처리)
- low: cc 멘션 (인지만 하면 됨)
- info: 직접 멘션 + 정보 공유/완료 통보 (응답 불필요)
- casual: 비업무 (식사/잡담/일정 친목)

Output JSON only, no markdown fences.`;

async function aiClassify(item) {
  if (!ANTHROPIC_KEY || args.noAi) {
    return { summary: "", recommend: "", priority: item.isCC ? "low" : "medium" };
  }
  const userMsg =
    `시각: ${item.time}\n` +
    `채팅방: ${item.chat}\n` +
    `작성자: ${item.author}\n` +
    `isCC: ${item.isCC}\n` +
    `원문: ${item.original}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        system: AI_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn(`  AI ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
      return { summary: "", recommend: "", priority: item.isCC ? "low" : "medium" };
    }
    const text = data.content?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text);
    return {
      summary: String(parsed.summary || "").slice(0, 80),
      recommend: String(parsed.recommend || "").slice(0, 120),
      priority: ["high", "medium", "low", "info", "casual"].includes(parsed.priority)
        ? parsed.priority
        : item.isCC ? "low" : "medium",
    };
  } catch (e) {
    console.warn(`  AI error: ${e.message}`);
    return { summary: "", recommend: "", priority: item.isCC ? "low" : "medium" };
  }
}

// ---- main -------------------------------------------------------------------
async function main() {
  const chatLabels = JSON.parse(
    await fs.readFile(path.join(dataDir, "chat-labels.json"), "utf8")
  );
  const chatIds = Object.keys(chatLabels);

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  const targetDate = kstDate(windowEnd);

  console.log(`Window: ${kstIso(windowStart)} → ${kstIso(windowEnd)}`);
  console.log(`Target date: ${targetDate}`);
  console.log(`Chats to poll: ${chatIds.length}`);

  console.log("Launching Edge (headless)...");
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: !args.headed,
    viewport: { width: 1280, height: 900 },
    channel: "msedge",
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://teams.microsoft.com/", { waitUntil: "domcontentloaded" });
  console.log("Waiting 25s for MSAL cache to populate...");
  await page.waitForTimeout(25_000);

  const token = await extractIc3Token(page);
  if (!token) {
    console.error("FATAL: ic3 token not found. Run `npm run setup-browser` to re-login.");
    await ctx.close();
    process.exit(1);
  }
  console.log(`Token OK (${token.length} chars)`);

  const since = windowStart.getTime();
  const raw = [];
  for (const chatId of chatIds) {
    const label = chatLabels[chatId];
    const r = await fetchChatMessages(page, token, chatId, since);
    if (r.status !== 200) {
      console.warn(`  [${r.status}] ${label}`);
      continue;
    }
    const msgs = r.body.messages || [];
    let count = 0;
    for (const m of msgs) {
      if (m.type !== "Message") continue;
      if (authoredByMe(m)) continue;
      const role = mentionRoleForMe(m);
      if (!role) continue;
      raw.push({ m, chatId, label, role });
      count++;
    }
    console.log(`  ${label}: ${msgs.length} msgs, ${count} mention(s)`);
  }

  await ctx.close();
  console.log(`Total mention candidates: ${raw.length}`);

  // dedup with previous day
  const prevDate = kstDate(new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000));
  const prevPath = path.join(dataDir, `${prevDate}.json`);
  const prevIds = new Set();
  try {
    const prev = JSON.parse(await fs.readFile(prevPath, "utf8"));
    for (const it of prev.items || []) if (it.messageId) prevIds.add(it.messageId);
    console.log(`Previous (${prevDate}): ${prevIds.size} ids loaded for dedup`);
  } catch {
    console.log(`Previous (${prevDate}): not found (skipping dedup)`);
  }
  const fresh = raw.filter((r) => !prevIds.has(r.m.id));
  console.log(`After dedup: ${fresh.length} items`);

  // sort newest-first
  fresh.sort((a, b) =>
    String(b.m.composetime || b.m.originalarrivaltime || "").localeCompare(
      String(a.m.composetime || a.m.originalarrivaltime || "")
    )
  );

  const dateCompact = targetDate.replaceAll("-", "");
  const items = fresh.map((r, i) => {
    const composeTime = new Date(r.m.composetime || r.m.originalarrivaltime);
    return {
      id: `${dateCompact}-${String(i + 1).padStart(2, "0")}`,
      time: kstDateTime(composeTime),
      chat: r.label,
      author: senderDisplay(r.m),
      priority: r.role === "cc" ? "low" : "medium",
      isCC: r.role === "cc",
      original: htmlToText(r.m.content),
      summary: "",
      recommend: "",
      links: extractLinks(r.m.content),
      messageId: r.m.id,
      chatId: r.chatId,
    };
  });

  if (ANTHROPIC_KEY && !args.noAi && items.length > 0) {
    console.log(`Calling Anthropic (${ANTHROPIC_MODEL}) for ${items.length} item(s)...`);
    for (const it of items) {
      const ai = await aiClassify(it);
      it.summary = ai.summary;
      it.recommend = ai.recommend;
      it.priority = ai.priority;
    }
  } else {
    console.log(`Applying heuristic (no AI) for ${items.length} item(s)...`);
    for (const it of items) {
      it.summary = heuristicSummary(it);
      it.priority = heuristicPriority(it);
      // recommend stays empty -> the REC row is omitted by index.html
    }
  }

  const stats = {
    total: items.length,
    high: items.filter((i) => i.priority === "high").length,
    medium: items.filter((i) => i.priority === "medium").length,
    cc: items.filter((i) => i.isCC).length,
  };

  const digest = {
    date: targetDate,
    generatedAt: kstIso(windowEnd),
    windowFrom: kstIso(windowStart),
    windowTo: kstIso(windowEnd),
    items,
    stats,
  };

  if (args.dryRun) {
    console.log("");
    console.log("---- DRY RUN: digest preview ----");
    console.log(JSON.stringify(digest, null, 2));
    return;
  }

  // write data/YYYY-MM-DD.json
  const outPath = path.join(dataDir, `${targetDate}.json`);
  await fs.writeFile(outPath, JSON.stringify(digest, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);

  // update data/index.json
  const idxPath = path.join(dataDir, "index.json");
  let idxData = { version: "1.0", retentionDays: 14, dates: [] };
  try { idxData = JSON.parse(await fs.readFile(idxPath, "utf8")); } catch {}
  idxData.lastUpdated = kstIso(new Date());
  idxData.dates = (idxData.dates || []).filter((d) => d.date !== targetDate);
  idxData.dates.unshift({
    date: targetDate,
    itemCount: stats.total,
    highCount: stats.high,
    mediumCount: stats.medium,
    ccCount: stats.cc,
  });
  idxData.dates.sort((a, b) => b.date.localeCompare(a.date));
  await fs.writeFile(idxPath, JSON.stringify(idxData, null, 2), "utf8");
  console.log(`Updated ${idxPath}`);

  // git commit + push
  if (!args.noCommit) {
    try {
      execSync("git add data/", { cwd: rootDir, stdio: "inherit" });
      execSync(
        `git commit -m "data: ${targetDate} digest (${stats.total} items)"`,
        { cwd: rootDir, stdio: "inherit" }
      );
      execSync("git push", { cwd: rootDir, stdio: "inherit" });
      console.log("Pushed to remote.");
    } catch (e) {
      console.warn(`git step failed: ${e.message}`);
      console.warn("(not fatal — JSON files are written; re-commit manually if needed)");
    }
  } else {
    console.log("Skipping git (--no-commit)");
  }

  console.log("");
  console.log(`Done. ${stats.total} items (${stats.high} high, ${stats.medium} medium, ${stats.cc} cc).`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
