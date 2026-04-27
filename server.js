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
  // 1. Environment variable override
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log("Using PUPPETEER_EXECUTABLE_PATH:", process.env.PUPPETEER_EXECUTABLE_PATH);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Try to find via 'which' command
  try {
    const p = execSync("which chromium || which chromium-browser || which google-chrome || which google-chrome-stable", { encoding: "utf8" }).trim().split("\n")[0];
    if (p && fs.existsSync(p)) {
      console.log("Found via which:", p);
      return p;
    }
  } catch (_) {}

  // 3. Try nix store paths (Railway nixpacks)
  try {
    const nixResult = execSync("find /nix/store -name 'chromium' -type f 2>/dev/null | head -5", { encoding: "utf8" }).trim();
    if (nixResult) {
      const lines = nixResult.split("\n").filter(l => l.includes("bin/chromium"));
      if (lines.length > 0) {
        console.log("Found in nix store:", lines[0]);
        return lines[0];
      }
    }
  } catch (_) {}

  // 4. Common static paths
  const staticPaths = [
    "/nix/var/nix/profiles/default/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
    "/usr/local/bin/chromium",
  ];
  for (const p of staticPaths) {
    if (fs.existsSync(p)) {
      console.log("Found at static path:", p);
      return p;
    }
  }

  throw new Error("Chromium not found! Set PUPPETEER_EXECUTABLE_PATH environment variable in Railway.");
}

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    const executablePath = findChromium();
    console.log("Launching browser at:", executablePath);

    browser = await puppeteer.launch({
      headless: "new",
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
      ],
    });
    console.log("Browser launched successfully!");
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

    // Click Pincode tab if present
    try {
      await page.evaluate(() => {
        const els = [...document.querySelectorAll("a, input[type=button], button, li, td")];
        const btn = els.find(el => (el.textContent || el.value || "").trim().toLowerCase() === "pincode");
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 1000));
    } catch (_) {}

    // Fill pincode input
    const filled = await page.evaluate((pin) => {
      const inputs = [...document.querySelectorAll("input[type=text], input:not([type])")];
      for (const inp of inputs) {
        const hint = `${inp.placeholder} ${inp.id} ${inp.name}`.toLowerCase();
        if (hint.includes("pin") || hint.includes("code")) {
          inp.value = pin;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      for (const inp of inputs) {
        if (inp.offsetParent !== null) {
          inp.value = pin;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
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
  } finally {
    await page.close();
  }
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
        const url = res.url();
        const ct = res.headers()["content-type"] || "";
        if (ct.includes("json") || (url.includes(".aspx") && !url.endsWith("network.aspx"))) {
          const text = await res.text().catch(() => "");
          if (text && text.length > 5 && text.length < 100000) {
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
          inp.value = pin;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      for (const inp of inputs) {
        if (inp.offsetParent !== null) {
          inp.value = pin;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
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
  } finally {
    await page.close();
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ Server on port ${PORT}`);
  try {
    const p = findChromium();
    console.log("Chromium path:", p);
  } catch (e) {
    console.error("⚠️ Chromium not found:", e.message);
  }
});

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit();
});
