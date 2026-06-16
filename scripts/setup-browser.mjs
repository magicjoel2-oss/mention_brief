// =============================================================================
// Mention Brief - Browser profile setup (Option D, one-time)
// =============================================================================
// Run once: open Chromium with a persistent profile, sign into teams.microsoft.com.
// Re-run anytime your session expires or MFA re-prompts.
//
//   PS> cd C:\AiApps\mention_brief
//   PS> npm install
//   PS> npx playwright install chromium     # if Chromium download is blocked, see fallback below
//   PS> npm run setup-browser
//
// Fallback if Playwright bundled Chromium download fails (corporate proxy):
//   Edit `LAUNCH_OPTS` below: uncomment `channel: 'msedge'` and remove the bundle download step.
// =============================================================================

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.resolve(__dirname, "..", ".browser-profile");

await fs.mkdir(profileDir, { recursive: true });

const LAUNCH_OPTS = {
  headless: false,
  viewport: { width: 1280, height: 900 },
  // Bundled Chromium download blocked by corporate SSL interception ->
  // use the system Edge that is already installed on this PC.
  channel: "msedge",
};

console.log(`Profile dir : ${profileDir}`);
console.log("Launching Chromium with persistent context...");

const ctx = await chromium.launchPersistentContext(profileDir, LAUNCH_OPTS);
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.goto("https://teams.microsoft.com/", { waitUntil: "domcontentloaded" });

console.log("");
console.log("============================================================");
console.log(" STEPS");
console.log(" 1. Sign in with magicjoel@nexon.co.kr");
console.log(" 2. Complete MFA if prompted");
console.log(" 3. Wait until the Teams left sidebar (Chat / Activity etc.) is");
console.log("    visible and fully loaded (~10-15s after sign-in)");
console.log(" 4. Just CLOSE the browser window when done.");
console.log("    Your cookies / MSAL cache are saved into .browser-profile/");
console.log("============================================================");
console.log("");

await new Promise((resolve) => ctx.once("close", resolve));
console.log("[OK] Browser closed. Profile saved.");
console.log("Next step: npm run poc-d");
