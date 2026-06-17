// =============================================================================
// One-shot script: encrypt every plaintext data/YYYY-MM-DD.json in place
// using the current MENTION_BRIEF_ANSWER. Run after changing the gate
// question/answer or after first introducing the gate.
//
//   PS> npm run reencrypt-data
//
// Notes:
//   - index.json and chat-labels.json stay plaintext (no sensitive content).
//   - Re-running on already-encrypted files is a no-op (detected by shape).
//   - If the answer changes, run this with the NEW answer in .env; it will
//     try to read existing files first as plaintext, fall back to decrypt
//     with OLD answer if you set MENTION_BRIEF_OLD_ANSWER.
// =============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");

function loadDotenv() {
  try {
    const text = fsSync.readFileSync(path.join(rootDir, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}
loadDotenv();

const QUESTION = process.env.MENTION_BRIEF_QUESTION;
const ANSWER = process.env.MENTION_BRIEF_ANSWER;
const OLD_ANSWER = process.env.MENTION_BRIEF_OLD_ANSWER || null;
const PBKDF2_ITER = 200000;

if (!QUESTION || !ANSWER) {
  console.error("MENTION_BRIEF_QUESTION / MENTION_BRIEF_ANSWER not set in .env");
  process.exit(1);
}

function deriveKey(answer, saltB64) {
  return crypto.pbkdf2Sync(answer, Buffer.from(saltB64, "base64"), PBKDF2_ITER, 32, "sha256");
}

function encryptPayload(obj, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    enc: "AES-256-GCM",
    iv: iv.toString("base64"),
    ct: Buffer.concat([ct, tag]).toString("base64"),
  };
}

function tryDecrypt(payload, key) {
  const ivBuf = Buffer.from(payload.iv, "base64");
  const combined = Buffer.from(payload.ct, "base64");
  const tag = combined.subarray(combined.length - 16);
  const ct = combined.subarray(0, combined.length - 16);
  const dec = crypto.createDecipheriv("aes-256-gcm", key, ivBuf);
  dec.setAuthTag(tag);
  const pt = Buffer.concat([dec.update(ct), dec.final()]);
  return JSON.parse(pt.toString("utf8"));
}

// ---- config -----------------------------------------------------------------
const configPath = path.join(dataDir, "_config.json");
let cfg = null;
try { cfg = JSON.parse(await fs.readFile(configPath, "utf8")); } catch {}
if (!cfg) {
  cfg = {
    v: 1,
    question: QUESTION,
    salt: crypto.randomBytes(16).toString("base64"),
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITER,
  };
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), "utf8");
  console.log(`Wrote new ${configPath}`);
} else if (cfg.question !== QUESTION) {
  // 질문만 갱신, salt 유지 — 기존 답으로 암호화된 데이터 호환을 위해
  cfg.question = QUESTION;
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), "utf8");
  console.log(`Updated question in ${configPath} (salt preserved).`);
} else {
  console.log(`Using existing config (unchanged).`);
}

const newKey = deriveKey(ANSWER, cfg.salt);
const oldKey = OLD_ANSWER ? deriveKey(OLD_ANSWER, cfg.salt) : null;

// ---- scan + encrypt ---------------------------------------------------------
const entries = await fs.readdir(dataDir);
const dailies = entries.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
console.log(`Found ${dailies.length} daily JSON file(s).`);

let nReencrypted = 0, nSkipped = 0, nFailed = 0;

for (const fname of dailies) {
  const full = path.join(dataDir, fname);
  const raw = JSON.parse(await fs.readFile(full, "utf8"));

  let plain;
  if (raw.enc === "AES-256-GCM" && raw.ct) {
    // already encrypted — try decrypt with new key first, then old.
    try {
      plain = tryDecrypt(raw, newKey);
      console.log(`  ${fname}: already encrypted with current answer, skip`);
      nSkipped++;
      continue;
    } catch {
      if (oldKey) {
        try {
          plain = tryDecrypt(raw, oldKey);
          console.log(`  ${fname}: decrypting with OLD_ANSWER, re-encrypting`);
        } catch {
          console.warn(`  ${fname}: decrypt failed with both keys — skip`);
          nFailed++;
          continue;
        }
      } else {
        console.warn(`  ${fname}: encrypted but new answer doesn't decrypt; set MENTION_BRIEF_OLD_ANSWER to rotate`);
        nFailed++;
        continue;
      }
    }
  } else if (Array.isArray(raw.items)) {
    plain = raw;
    console.log(`  ${fname}: plaintext, encrypting`);
  } else {
    console.warn(`  ${fname}: unknown shape, skip`);
    nFailed++;
    continue;
  }

  const enc = encryptPayload(plain, newKey);
  await fs.writeFile(full, JSON.stringify(enc, null, 2), "utf8");
  nReencrypted++;
}

console.log("");
console.log(`Done. re-encrypted: ${nReencrypted}, skipped: ${nSkipped}, failed: ${nFailed}`);
