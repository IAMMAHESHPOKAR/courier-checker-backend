const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    // Find chromium path
    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      "/run/current-system/sw/bin/chromium" ||
      undefined;

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
      ],
    });
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
    await page.setDefaultTimeout(25000);

    await page.goto("https://www.tpcindia.com/Network.aspx", {
      waitUntil: "networkidle2",
    });

    // Click Pincode tab if present
    try {
      await page.evaluate(() => {
        const els = [...document.querySelectorAll("a, input[type=button], button, li, td")];
        const btn = els.find((el) =>
          (el.textContent || el.value || "").trim().toLowerCase() === "pincode"
        );
        if (btn) btn.click();
      });
      await new Promise((r) => setTimeout(r, 1000));
    } catch (_) {}

    // Find pincode input
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
      // fallback: first visible text input
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

    // Click search button
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("input[type=submit], input[type=button], button")];
      const btn = btns.find((b) =>
        /search|go|find|submit/i.test(b.value || b.textContent || "")
      );
      if (btn) btn.click();
    });

    await new Promise((r) => setTimeout(r, 4000));

    // Extract result table
    const result = await page.evaluate(() => {
      const tables = [...document.querySelectorAll("table")];
      let best = null, bestScore = 0;
      for (const t of tables) {
        const txt = t.innerText.toLowerCase();
        const score =
          (txt.includes("station") ? 3 : 0) +
          (txt.includes("city") ? 2 : 0) +
          (txt.includes("state") ? 2 : 0) +
          (txt.includes("code") ? 1 : 0) +
          (txt.includes("phone") ? 1 : 0);
        if (score > bestScore && t.rows.length > 1) {
          bestScore = score;
          best = t;
        }
      }
      if (!best || bestScore < 3) return null;

      const headers = [...best.rows[0].cells].map((c) => c.innerText.trim());
      const rows = [];
      for (let i = 1; i < best.rows.length; i++) {
        const cells = [...best.rows[i].cells].map((c) => c.innerText.trim());
        if (cells.every((c) => !c)) continue;
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
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setDefaultTimeout(25000);

    let ajaxResult = null;

    await page.setRequestInterception(true);
    page.on("request", (req) => req.continue());
    page.on("response", async (res) => {
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

    await page.goto("http://www.shreetirupaticourier.net/network.aspx", {
      waitUntil: "networkidle2",
    });

    // Fill pincode
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
        const btn = btns.find((b) =>
          /search|go|find|submit/i.test(b.value || b.textContent || b.innerText || "")
        );
        if (btn) btn.click();
      });
      await new Promise((r) => setTimeout(r, 4000));
    }

    // Try AJAX result first
    if (ajaxResult) return { available: true, data: ajaxResult };

    // Fallback: scrape DOM table
    const domResult = await page.evaluate(() => {
      const tables = [...document.querySelectorAll("table")];
      let best = null, bestScore = 0;
      for (const t of tables) {
        const txt = t.innerText.toLowerCase();
        const score =
          (txt.includes("branch") ? 3 : 0) +
          (txt.includes("city") ? 2 : 0) +
          (txt.includes("state") ? 1 : 0) +
          (txt.includes("phone") ? 1 : 0) +
          (txt.includes("pin") ? 1 : 0);
        if (score > bestScore && t.rows.length > 1) {
          bestScore = score;
          best = t;
        }
      }
      if (!best || bestScore < 3) return null;

      const headers = [...best.rows[0].cells].map((c) => c.innerText.trim());
      const rows = [];
      for (let i = 1; i < best.rows.length; i++) {
        const cells = [...best.rows[i].cells].map((c) => c.innerText.trim());
        if (cells.every((c) => !c)) continue;
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
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.get("/api/check/:pincode", async (req, res) => {
  const { pincode } = req.params;
  if (!/^\d{6}$/.test(pincode)) {
    return res.status(400).json({ error: "Invalid pincode" });
  }

  const [tpcResult, stcResult] = await Promise.allSettled([
    fetchTPC(pincode),
    fetchSTC(pincode),
  ]);

  res.json({
    pincode,
    tpc: tpcResult.status === "fulfilled" ? tpcResult.value : { available: false, error: tpcResult.reason?.message },
    stc: stcResult.status === "fulfilled" ? stcResult.value : { available: false, error: stcResult.reason?.message },
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  try {
    await getBrowser();
    console.log("🌐 Browser ready");
  } catch (e) {
    console.error("Browser init failed:", e.message);
  }
});

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit();
});
