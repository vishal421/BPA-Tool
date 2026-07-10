/**
 * BPA Proxy Server
 * ------------------------------------------------------------
 * Runs on your own machine (e.g. Ubuntu) and does the actual
 * calls to Palo Alto's Posture Management API server-to-server,
 * exactly like curl would. The browser only ever talks to THIS
 * server (same-origin), so CORS never comes into play.
 *
 * Requires Node.js 18+ (for built-in fetch and zlib.gzipSync).
 * ------------------------------------------------------------
 */

const express = require("express");
const multer = require("multer");
const zlib = require("zlib");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static("public"));

const AUTH_URL = "https://auth.apps.paloaltonetworks.com/am/oauth2/access_token";
const API_BASE = "https://api.sase.paloaltonetworks.com/posture/checks/v1/reports";

// ---------- 1. Get access token ----------
app.post("/api/token", async (req, res) => {
  const { client_id, client_secret, tsg_id } = req.body;
  if (!client_id || !client_secret || !tsg_id) {
    return res.status(400).json({ error: "client_id, client_secret and tsg_id are all required" });
  }
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id,
      client_secret,
      scope: `tsg_id:${tsg_id}`,
    });
    const panResp = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await panResp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

    if (!panResp.ok) {
      return res.status(panResp.status).json({ error: "Palo Alto auth error", details: data });
    }
    return res.json(data);
  } catch (err) {
    console.error("[token] error:", err.message);
    return res.status(502).json({ error: "Failed to reach Palo Alto auth endpoint", details: err.message });
  }
});

// ---------- 2. Initiate config upload ----------
app.post("/api/initiate-upload", async (req, res) => {
  const { token, device_type } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });
  try {
    const panResp = await fetch(`${API_BASE}/config-file-upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_type: device_type || "panorama", delete_after_processing: true }),
    });
    const text = await panResp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

    if (!panResp.ok) {
      return res.status(panResp.status).json({ error: "Palo Alto API error", details: data });
    }
    return res.json(data);
  } catch (err) {
    console.error("[initiate-upload] error:", err.message);
    return res.status(502).json({ error: "Failed to reach Palo Alto API", details: err.message });
  }
});

const https = require("https");
const { URL } = require("url");

/**
 * Performs a PUT with an exact Content-Length and only the headers we specify.
 * This avoids Node's fetch() sometimes using chunked transfer-encoding, which
 * breaks GCS V4 signed URLs (they expect a fixed, exact set of signed headers).
 */
function putBuffer(urlString, buffer, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "PUT",
      headers: {
        ...extraHeaders,
        "Content-Length": Buffer.byteLength(buffer),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

// ---------- 3. Gzip + upload the config file to the presigned URL ----------
app.post("/api/upload-file", upload.single("file"), async (req, res) => {
  const { upload_url } = req.body;
  if (!upload_url) return res.status(400).json({ error: "upload_url is required" });
  if (!req.file) return res.status(400).json({ error: "No file received" });

  try {
    const gzipped = zlib.gzipSync(req.file.buffer);
    const result = await putBuffer(upload_url, gzipped, {
      "Content-Type": "plain/text",
      "Content-Encoding": "gzip",
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return res.status(result.statusCode).json({ error: "Upload to presigned URL failed", details: result.body });
    }
    return res.json({ ok: true, status: result.statusCode });
  } catch (err) {
    console.error("[upload-file] error:", err.message);
    return res.status(502).json({ error: "Failed to upload file", details: err.message });
  }
});

// ---------- 3b. Fetch config file from a remote URL, then gzip + upload it ----------
app.post("/api/upload-from-url", async (req, res) => {
  const { file_url, upload_url } = req.body;
  if (!file_url) return res.status(400).json({ error: "file_url is required" });
  if (!upload_url) return res.status(400).json({ error: "upload_url is required" });

  try {
    // Fetch the source file from wherever it's hosted
    const fileResp = await fetch(file_url);
    if (!fileResp.ok) {
      return res.status(fileResp.status).json({
        error: "Could not download file from the provided URL",
        details: `Remote server responded with ${fileResp.status}`,
      });
    }
    const arrayBuf = await fileResp.arrayBuffer();
    if (arrayBuf.byteLength === 0) {
      return res.status(400).json({ error: "Downloaded file is empty — check the URL is publicly accessible and points directly to the file (not an HTML preview/login page)." });
    }

    // Gzip and forward to Palo Alto's presigned URL, same as the local-upload path
    const gzipped = zlib.gzipSync(Buffer.from(arrayBuf));
    const result = await putBuffer(upload_url, gzipped, {
      "Content-Type": "plain/text",
      "Content-Encoding": "gzip",
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return res.status(result.statusCode).json({ error: "Upload to presigned URL failed", details: result.body });
    }
    return res.json({ ok: true, status: result.statusCode, bytes: arrayBuf.byteLength });
  } catch (err) {
    console.error("[upload-from-url] error:", err.message);
    return res.status(502).json({ error: "Failed to fetch or forward the file", details: err.message });
  }
});

// ---------- 4. Poll BPA result ----------
app.get("/api/status", async (req, res) => {
  const { token, id } = req.query;
  if (!token || !id) return res.status(400).json({ error: "token and id are both required" });
  try {
    const panResp = await fetch(`${API_BASE}/${id}/bpa-result`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await panResp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

    if (!panResp.ok) {
      return res.status(panResp.status).json({ error: "Palo Alto API error", details: data });
    }
    return res.json(data);
  } catch (err) {
    console.error("[status] error:", err.message);
    return res.status(502).json({ error: "Failed to reach Palo Alto API", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  BPA Proxy running → http://localhost:${PORT}\n`);
});
