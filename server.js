const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Launch browser once and reuse ───────────────────────────────────────────
let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    const launchOptions = {
      headless: "new",
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
    };
    // Use system Chrome if available (Railway/Linux servers)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    browser = await puppeteer.launch(launchOptions);
  }
  return browser;
}

// ─── TPC India Scraper ────────────────────────────────────────────────────────
async function fetchTPC(pincode) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setDefaultTimeout(20000);

    await page.goto("https://www.tpcindia.com/Network.aspx", {
      waitUntil: "networkidle2",
    });

    // Click "Pincode" tab if needed
    try {
      await page.evaluate(() => {
        const links = [...document.querySelectorAll("a, input[type=button], button")];
        const pincodeBtn = links.find(
          (el) => el.textContent?.trim().toLowerCase() === "pincode"
        );
        if (pincodeBtn) pincodeBtn.click();
      });
      await new Promise((r) => setTimeout(r, 800));
    } catch (_) {}

    // Find the pincode input field
    const inputSelector = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input[type=text], input:not([type])")];
      for (const inp of inputs) {
        const placeholder = (inp.placeholder || "").toLowerCase();
        const id = (inp.id || "").toLowerCase();
        const name = (inp.name || "").toLowerCase();
        if (
          placeholder.includes("pin") ||
          id.includes("pin") ||
          name.includes("pin")
        ) {
          // Give it a unique marker
          inp.setAttribute("data-scraper-target", "pincode");
          return "[data-scraper-target='pincode']";
        }
      }
      // fallback: first visible text input
      for (const inp of inputs) {
        if (inp.offsetParent !== null) {
          inp.setAttribute("data-scraper-target", "pincode");
          return "[data-scraper-target='pincode']";
        }
      }
      return null;
    });

    if (!inputSelector) throw new Error("Pincode input not found on TPC page");

    await page.click(inputSelector, { clickCount: 3 });
    await page.type(inputSelector, pincode, { delay: 80 });

    // Click Search button
    await page.evaluate(() => {
      const btns = [
        ...document.querySelectorAll("input[type=submit], input[type=button], button"),
      ];
      const searchBtn = btns.find((b) => {
        const txt = (b.value || b.textContent || "").toLowerCase();
        return txt.includes("search") || txt.includes("go") || txt.includes("find");
      });
      if (searchBtn) searchBtn.click();
    });

    // Wait for results
    await new Promise((r) => setTimeout(r, 3000));

    // Extract result table
    const result = await page.evaluate(() => {
      const tables = document.querySelectorAll("table");
      let bestTable = null;
      let bestScore = 0;

      for (const table of tables) {
        const txt = table.innerText.toLowerCase();
        const score =
          (txt.includes("station") ? 2 : 0) +
          (txt.includes("city") ? 2 : 0) +
          (txt.includes("state") ? 2 : 0) +
          (txt.includes("code") ? 1 : 0) +
          (txt.includes("phone") ? 1 : 0) +
          (txt.includes("address") ? 1 : 0);
        if (score > bestScore && table.rows.length > 1) {
          bestScore = score;
          bestTable = table;
        }
      }

      if (!bestTable || bestScore < 2) return null;

      const rows = [];
      const headerRow = bestTable.rows[0];
      const headers = [...headerRow.cells].map((c) => c.innerText.trim());

      for (let i = 1; i < bestTable.rows.length; i++) {
        const cells = [...bestTable.rows[i].cells].map((c) => c.innerText.trim());
        if (cells.every((c) => c === "")) continue;
        const obj = {};
        headers.forEach((h, idx) => {
          if (h && cells[idx]) obj[h] = cells[idx];
        });
        if (Object.keys(obj).length > 0) rows.push(obj);
      }

      return rows.length > 0 ? rows : null;
    });

    return result
      ? { available: true, data: result }
      : { available: false, data: [] };
  } catch (err) {
    throw new Error("TPC fetch failed: " + err.message);
  } finally {
    await page.close();
  }
}

// ─── Shree Tirupati Scraper ───────────────────────────────────────────────────
async function fetchSTC(pincode) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setDefaultTimeout(20000);

    // Intercept AJAX responses to capture the API endpoint
    let ajaxData = null;
    await page.setRequestInterception(true);

    page.on("request", (req) => req.continue());
    page.on("response", async (res) => {
      try {
        const url = res.url();
        const ct = res.headers()["content-type"] || "";
        if (
          (url.includes("network") || url.includes("Network") || url.includes("search")) &&
          (ct.includes("json") || ct.includes("xml") || ct.includes("text"))
        ) {
          const text = await res.text().catch(() => "");
          if (text && text.length > 10 && text.length < 50000) {
            ajaxData = { url, text };
          }
        }
      } catch (_) {}
    });

    await page.goto("http://www.shreetirupaticourier.net/network.aspx", {
      waitUntil: "networkidle2",
    });

    // Find and fill pincode input
    const inputSel = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input[type=text], input:not([type])")];
      for (const inp of inputs) {
        const p = (inp.placeholder || "").toLowerCase();
        const id = (inp.id || "").toLowerCase();
        if (p.includes("pin") || id.includes("pin")) {
          inp.setAttribute("data-stc", "pin");
          return "[data-stc='pin']";
        }
      }
      // Try any visible text input
      for (const inp of inputs) {
        if (inp.offsetParent !== null) {
          inp.setAttribute("data-stc", "pin");
          return "[data-stc='pin']";
        }
      }
      return null;
    });

    if (inputSel) {
      await page.click(inputSel, { clickCount: 3 });
      await page.type(inputSel, pincode, { delay: 80 });

      // Click search
      await page.evaluate(() => {
        const btns = [
          ...document.querySelectorAll(
            "input[type=submit], input[type=button], button, a"
          ),
        ];
        const btn = btns.find((b) => {
          const txt = (b.value || b.textContent || b.innerText || "").toLowerCase();
          return (
            txt.includes("search") ||
            txt.includes("go") ||
            txt.includes("find") ||
            txt.includes("submit")
          );
        });
        if (btn) btn.click();
      });

      await new Promise((r) => setTimeout(r, 3000));
    }

    // Try to extract result from DOM
    const domResult = await page.evaluate(() => {
      const tables = document.querySelectorAll("table");
      let best = null;
      let bestScore = 0;

      for (const t of tables) {
        const txt = t.innerText.toLowerCase();
        const score =
          (txt.includes("branch") ? 2 : 0) +
          (txt.includes("city") ? 2 : 0) +
          (txt.includes("state") ? 1 : 0) +
          (txt.includes("phone") ? 1 : 0) +
          (txt.includes("pin") ? 1 : 0);
        if (score > bestScore && t.rows.length > 1) {
          bestScore = score;
          best = t;
        }
      }

      if (!best || bestScore < 2) return null;

      const headers = [...best.rows[0].cells].map((c) => c.innerText.trim());
      const rows = [];
      for (let i = 1; i < best.rows.length; i++) {
        const cells = [...best.rows[i].cells].map((c) => c.innerText.trim());
        if (cells.every((c) => c === "")) continue;
        const obj = {};
        headers.forEach((h, idx) => { if (h && cells[idx]) obj[h] = cells[idx]; });
        if (Object.keys(obj).length > 0) rows.push(obj);
      }
      return rows.length > 0 ? rows : null;
    });

    if (domResult) return { available: true, data: domResult };

    // Try AJAX intercepted data
    if (ajaxData) {
      try {
        const json = JSON.parse(ajaxData.text);
        const arr = Array.isArray(json) ? json : json.data || json.result || json.records || [];
        if (arr.length > 0) return { available: true, data: arr };
      } catch (_) {}
    }

    return { available: false, data: [] };
  } catch (err) {
    throw new Error("STC fetch failed: " + err.message);
  } finally {
    await page.close();
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/check/:pincode", async (req, res) => {
  const { pincode } = req.params;

  if (!/^\d{6}$/.test(pincode)) {
    return res.status(400).json({ error: "Invalid pincode. Must be 6 digits." });
  }

  const results = await Promise.allSettled([fetchTPC(pincode), fetchSTC(pincode)]);

  const tpc =
    results[0].status === "fulfilled"
      ? results[0].value
      : { available: false, error: results[0].reason?.message };

  const stc =
    results[1].status === "fulfilled"
      ? results[1].value
      : { available: false, error: results[1].reason?.message };

  res.json({ pincode, tpc, stc });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ Courier Checker API running on http://localhost:${PORT}`);
  // Pre-warm browser
  try {
    await getBrowser();
    console.log("🌐 Browser ready");
  } catch (e) {
    console.error("Browser init failed:", e.message);
  }
});

// Cleanup on exit
process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit();
});
