const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

// ─── TPC India ─────────────────────────────────────────────────────────────
async function fetchTPC(pincode) {
  try {
    // Step 1: GET page to extract ViewState + EventValidation
    const getRes = await axios.get("https://www.tpcindia.com/Network.aspx", {
      headers: HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(getRes.data);
    const viewState = $("#__VIEWSTATE").val() || "";
    const viewStateGen = $("#__VIEWSTATEGENERATOR").val() || "";
    const eventValidation = $("#__EVENTVALIDATION").val() || "";
    const cookies = getRes.headers["set-cookie"]?.join("; ") || "";

    // Step 2: Click "Pincode" tab first
    const tabRes = await axios.post(
      "https://www.tpcindia.com/Network.aspx",
      new URLSearchParams({
        __EVENTTARGET: "ctl00$ctl00$ContentPlaceHolderBottom$ContentPlaceHolderQuickLinkBottom$btnPincode",
        __EVENTARGUMENT: "",
        __VIEWSTATE: viewState,
        __VIEWSTATEGENERATOR: viewStateGen,
        __EVENTVALIDATION: eventValidation,
      }).toString(),
      {
        headers: {
          ...HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": cookies,
          "Referer": "https://www.tpcindia.com/Network.aspx",
        },
        timeout: 15000,
      }
    );

    const $2 = cheerio.load(tabRes.data);
    const vs2 = $2("#__VIEWSTATE").val() || "";
    const vsGen2 = $2("#__VIEWSTATEGENERATOR").val() || "";
    const ev2 = $2("#__EVENTVALIDATION").val() || "";
    const cookies2 = tabRes.headers["set-cookie"]?.join("; ") || cookies;

    // Find pincode input name
    let pincodeField = "ctl00$ctl00$ContentPlaceHolderBottom$ContentPlaceHolderQuickLinkBottom$txtPincode";
    $2("input[type=text]").each((_, el) => {
      const name = $2(el).attr("name") || "";
      if (name.toLowerCase().includes("pin")) pincodeField = name;
    });

    // Find search button name
    let searchBtn = "ctl00$ctl00$ContentPlaceHolderBottom$ContentPlaceHolderQuickLinkBottom$btnSearch";
    $2("input[type=submit], input[type=button]").each((_, el) => {
      const val = ($2(el).attr("value") || "").toLowerCase();
      const name = $2(el).attr("name") || "";
      if (val.includes("search") || val.includes("go")) searchBtn = name;
    });

    // Step 3: Submit pincode search
    const searchRes = await axios.post(
      "https://www.tpcindia.com/Network.aspx",
      new URLSearchParams({
        __EVENTTARGET: "",
        __EVENTARGUMENT: "",
        __VIEWSTATE: vs2,
        __VIEWSTATEGENERATOR: vsGen2,
        __EVENTVALIDATION: ev2,
        [pincodeField]: pincode,
        [searchBtn]: "Search",
      }).toString(),
      {
        headers: {
          ...HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": cookies2,
          "Referer": "https://www.tpcindia.com/Network.aspx",
        },
        timeout: 15000,
      }
    );

    const $3 = cheerio.load(searchRes.data);
    const rows = [];

    // Extract all tables and find the result one
    $3("table").each((_, table) => {
      const txt = $3(table).text().toLowerCase();
      if (
        (txt.includes("station") || txt.includes("city")) &&
        txt.includes("state")
      ) {
        const headerCells = $3(table).find("tr").first().find("th, td");
        const headers = [];
        headerCells.each((_, cell) => headers.push($3(cell).text().trim()));

        $3(table).find("tr").slice(1).each((_, row) => {
          const cells = [];
          $3(row).find("td").each((_, cell) => cells.push($3(cell).text().trim()));
          if (cells.length > 0 && cells.some(c => c)) {
            const obj = {};
            headers.forEach((h, i) => { if (h && cells[i]) obj[h] = cells[i]; });
            if (Object.keys(obj).length > 0) rows.push(obj);
          }
        });
      }
    });

    if (rows.length > 0) return { available: true, data: rows };

    // Check for "no result" message
    const pageText = $3("body").text().toLowerCase();
    if (pageText.includes("no record") || pageText.includes("not found") || pageText.includes("no data")) {
      return { available: false, data: [] };
    }

    return { available: false, data: [] };
  } catch (err) {
    throw new Error("TPC fetch failed: " + err.message);
  }
}

// ─── Shree Tirupati Courier ──────────────────────────────────────────────────
async function fetchSTC(pincode) {
  try {
    // Step 1: GET page
    const getRes = await axios.get("http://www.shreetirupaticourier.net/network.aspx", {
      headers: HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(getRes.data);
    const viewState = $("#__VIEWSTATE").val() || "";
    const viewStateGen = $("#__VIEWSTATEGENERATOR").val() || "";
    const eventValidation = $("#__EVENTVALIDATION").val() || "";
    const cookies = getRes.headers["set-cookie"]?.join("; ") || "";

    // Find pincode input name
    let pincodeField = "txtPincode";
    $("input[type=text]").each((_, el) => {
      const name = $(el).attr("name") || "";
      const id = $(el).attr("id") || "";
      if (name.toLowerCase().includes("pin") || id.toLowerCase().includes("pin")) {
        pincodeField = name || id;
      }
    });

    // Find search button
    let searchBtnName = "btnSearch";
    let searchBtnVal = "Search";
    $("input[type=submit], input[type=button], button[type=submit]").each((_, el) => {
      const val = ($(el).attr("value") || $(el).text() || "").toLowerCase();
      if (val.includes("search") || val.includes("go") || val.includes("find")) {
        searchBtnName = $(el).attr("name") || searchBtnName;
        searchBtnVal = $(el).attr("value") || searchBtnVal;
      }
    });

    // Find __EVENTTARGET if button uses doPostBack
    let eventTarget = "";
    $("input[type=button], a").each((_, el) => {
      const onclick = $(el).attr("onclick") || "";
      if (onclick.includes("__doPostBack") && /search|go|find/i.test($(el).attr("value") || $(el).text() || "")) {
        const match = onclick.match(/__doPostBack\('([^']+)'/);
        if (match) eventTarget = match[1];
      }
    });

    // Step 2: POST with pincode
    const formData = {
      __EVENTTARGET: eventTarget,
      __EVENTARGUMENT: "",
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewStateGen,
      __EVENTVALIDATION: eventValidation,
      [pincodeField]: pincode,
    };
    if (!eventTarget) formData[searchBtnName] = searchBtnVal;

    const searchRes = await axios.post(
      "http://www.shreetirupaticourier.net/network.aspx",
      new URLSearchParams(formData).toString(),
      {
        headers: {
          ...HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": cookies,
          "Referer": "http://www.shreetirupaticourier.net/network.aspx",
        },
        timeout: 15000,
      }
    );

    const $2 = cheerio.load(searchRes.data);
    const rows = [];

    $2("table").each((_, table) => {
      const txt = $2(table).text().toLowerCase();
      if (
        (txt.includes("branch") || txt.includes("city") || txt.includes("station")) &&
        (txt.includes("phone") || txt.includes("state") || txt.includes("pin"))
      ) {
        const headerCells = $2(table).find("tr").first().find("th, td");
        const headers = [];
        headerCells.each((_, cell) => headers.push($2(cell).text().trim()));

        $2(table).find("tr").slice(1).each((_, row) => {
          const cells = [];
          $2(row).find("td").each((_, cell) => cells.push($2(cell).text().trim()));
          if (cells.length > 0 && cells.some(c => c)) {
            const obj = {};
            headers.forEach((h, i) => { if (h && cells[i]) obj[h] = cells[i]; });
            if (Object.keys(obj).length > 0) rows.push(obj);
          }
        });
      }
    });

    if (rows.length > 0) return { available: true, data: rows };
    return { available: false, data: [] };
  } catch (err) {
    throw new Error("STC fetch failed: " + err.message);
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

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
