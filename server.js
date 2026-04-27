const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const { execSync } = require("child_process");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

let browser = null;

function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    const p = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (fs.existsSync(p)) return p;
    console.log("PUPPETEER_EXECUTABLE_PATH set but file not found:", p);
  }

  // Try which commands
  const whichCmds = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  for (const cmd of whichCmds) {
    try {
      const p = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (p && fs.existsSync(p)) return p;
    } catch (_) {}
  }

  // Find in nix store
  try {
    const result = execSync("find /nix/store -name 'chromium' -type f 2>/dev/null | grep '/bin/chromium$' | head -3", { encoding: "utf8" }).trim();
    const lines = result.split("\n").filter(Boolean);
    if (lines.length > 0 && fs.existsSync(lines[0])) return lines[0];
  } catch (_) {}

  // Static paths
  const paths = [
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
    "/usr/local/bin/chromium", "/snap/bin/chromium",
    "/nix/var/nix/profiles/default/bin/chromium",
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error("Chromium not found anywhere!");
}

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    const executablePath = findChromium();
    console.log("Launching Chromium at:", executablePath);
    browser = await puppeteer.launch({
      headless: "new",
      executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-zygote", "--single-process"],
    });
  }
  return browser;
}

// ─── TPC India Scraper ────────────────────────────────────────────────────────
async function fetchTPC(pincode) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    await page.setDefaultTimeout(25000);
    await page.goto("https://www.tpcindia.com/Network.aspx", { waitUntil: "networkidle2" });

    try {
      await page.evaluate(() => {
        const els = [...document.querySelectorAll("a, input[type=button], button, li, td")];
        const btn = els.find(el => (el.textContent || el.value || "").trim().toLowerCase() === "pincode");
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 1000));
    } catch (_) {}

    const filled = await page.evaluate((pin) => {
      const inputs = [...document.querySelectorAll("input[type=text], input:not([type])")];
      for (const inp of inputs) {
        const hint = `${inp.placeholder} ${inp.id} ${inp.name}`.toLowerCase();
        if (hint.includes("pin") || hint.includes("code")) {
          inp.value = pin; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); return true;
        }
      }
      for (const inp of inputs) {
        if (inp.offsetParent !== null) { inp.value = pin; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); return true; }
      }
      return false;
    }, pincode);

    if (!filled) throw new Error("Could not find pincode input on TPC page");

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("input[type=submit], input[type=button], button")];
      const btn = btns.find(b => /search|go|find|submit/i.test(b.value || b.textContent || ""));
      if (btn) btn.click();
    });

    await new Promise(r => setTimeout(r, 4000));

    const result = await page.evaluate(() => {
      const tables = [...document.querySelectorAll("table")];
      let best = null, bestScore = 0;
      for (const t of tables) {
        const txt = t.innerText.toLowerCase();
        const score = (txt.includes("station") ? 3 : 0) + (txt.includes("city") ? 2 : 0) + (txt.includes("state") ? 2 : 0) + (txt.includes("phone") ? 1 : 0);
        if (score > bestScore && t.rows.length > 1) { bestScore = score; best = t; }
      }
      if (!best || bestScore < 3) return null;
      const headers = [...best.rows[0].cells].map(c => c.innerText.trim());
      const rows = [];
      for (let i = 1; i < best.rows.length; i++) {
        const cells = [...best.rows[i].cells].map(c => c.innerText.trim());
        if (cells.every(c => !c)) continue;
        const obj = {};
        headers.forEach((h, idx) => { if (h && cells[idx]) obj[h] = cells[idx]; });
        if (Object.keys(obj).length > 0) rows.push(obj);
      }
      return rows.length > 0 ? rows : null;
    });

    return result ? { available: true, data: result } : { available: false, data: [] };
  } finally { await page.close(); }
}

// ─── Shree Tirupati Scraper ───────────────────────────────────────────────────
async function fetchSTC(pincode) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    await page.setDefaultTimeout(25000);

    let ajaxResult = null;
    await page.setRequestInterception(true);
    page.on("request", req => req.continue());
    page.on("response", async res => {
      try {
        const ct = res.headers()["content-type"] || "";
        if (ct.includes("json")) {
          const text = await res.text().catch(() => "");
          if (text && text.length > 5) {
            try {
              const json = JSON.parse(text);
              const arr = Array.isArray(json) ? json : json.d || json.data || json.result || [];
              if (Array.isArray(arr) && arr.length > 0) ajaxResult = arr;
            } catch (_) {}
          }
        }
      } catch (_) {}
    });

    await page.goto("http://www.shreetirupaticourier.net/network.aspx", { waitUntil: "networkidle2" });

    const filled = await page.evaluate((pin) => {
      const inputs = [...document.querySelectorAll("input[type=text], input:not([type])")];
      for (const inp of inputs) {
        const hint = `${inp.placeholder} ${inp.id} ${inp.name}`.toLowerCase();
        if (hint.includes("pin") || hint.includes("code")) {
          inp.value = pin; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); return true;
        }
      }
      for (const inp of inputs) {
        if (inp.offsetParent !== null) { inp.value = pin; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); return true; }
      }
      return false;
    }, pincode);

    if (filled) {
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll("input[type=submit], input[type=button], button, a")];
        const btn = btns.find(b => /search|go|find|submit/i.test(b.value || b.textContent || b.innerText || ""));
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 4000));
    }

    if (ajaxResult) return { available: true, data: ajaxResult };

    const domResult = await page.evaluate(() => {
      const tables = [...document.querySelectorAll("table")];
      let best = null, bestScore = 0;
      for (const t of tables) {
        const txt = t.innerText.toLowerCase();
        const score = (txt.includes("branch") ? 3 : 0) + (txt.includes("city") ? 2 : 0) + (txt.includes("state") ? 1 : 0) + (txt.includes("phone") ? 1 : 0);
        if (score > bestScore && t.rows.length > 1) { bestScore = score; best = t; }
      }
      if (!best || bestScore < 3) return null;
      const headers = [...best.rows[0].cells].map(c => c.innerText.trim());
      const rows = [];
      for (let i = 1; i < best.rows.length; i++) {
        const cells = [...best.rows[i].cells].map(c => c.innerText.trim());
        if (cells.every(c => !c)) continue;
        const obj = {};
        headers.forEach((h, idx) => { if (h && cells[idx]) obj[h] = cells[idx]; });
        if (Object.keys(obj).length > 0) rows.push(obj);
      }
      return rows.length > 0 ? rows : null;
    });

    return domResult ? { available: true, data: domResult } : { available: false, data: [] };
  } finally { await page.close(); }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// DEBUG: Find exact chromium path on this server
app.get("/debug", (req, res) => {
  const results = {};

  // Check env var
  results.env_var = process.env.PUPPETEER_EXECUTABLE_PATH || "not set";

  // which commands
  const cmds = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  results.which = {};
  for (const cmd of cmds) {
    try { results.which[cmd] = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf8" }).trim() || "not found"; }
    catch (_) { results.which[cmd] = "not found"; }
  }

  // Check if files exist
  const paths = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/local/bin/chromium"];
  results.file_exists = {};
  for (const p of paths) { results.file_exists[p] = fs.existsSync(p); }

  // Nix store
  try { results.nix_store = execSync("find /nix/store -name 'chromium' -type f 2>/dev/null | grep '/bin/' | head -5", { encoding: "utf8" }).trim() || "nothing found"; }
  catch (_) { results.nix_store = "error"; }

  res.json(results);
});

app.get("/health", (req, res) => {
  let chromePath = "unknown";
  try { chromePath = findChromium(); } catch (e) { chromePath = "NOT FOUND: " + e.message; }
  res.json({ status: "ok", chromePath, time: new Date().toISOString() });
});

app.get("/api/check/:pincode", async (req, res) => {
  const { pincode } = req.params;
  if (!/^\d{6}$/.test(pincode)) return res.status(400).json({ error: "Invalid pincode" });

  const [tpcRes, stcRes] = await Promise.allSettled([fetchTPC(pincode), fetchSTC(pincode)]);
  res.json({
    pincode,
    tpc: tpcRes.status === "fulfilled" ? tpcRes.value : { available: false, error: tpcRes.reason?.message },
    stc: stcRes.status === "fulfilled" ? stcRes.value : { available: false, error: stcRes.reason?.message },
  });
});

app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));

process.on("SIGINT", async () => { if (browser) await browser.close(); process.exit(); });
