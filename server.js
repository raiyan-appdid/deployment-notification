// Dokploy -> Bitrix24 notification relay
// Receives Dokploy "Custom" notification webhooks and forwards them to a
// Bitrix24 chat via an inbound webhook (im.message.add). Zero dependencies.

const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
// e.g. https://yourcompany.bitrix24.com/rest/1/abc123xyz/   (trailing slash optional)
const BITRIX_WEBHOOK_URL = (process.env.BITRIX_WEBHOOK_URL || "").replace(/\/+$/, "");
// One or more chats, comma separated: chat123, sg45 (workgroup), 17 (a user)
const DIALOG_IDS = (process.env.BITRIX_DIALOG_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Shared secret Dokploy sends in the X-Relay-Secret header
const RELAY_SECRET = process.env.RELAY_SECRET || "";
// Rich card (colored bar + fields). Set to "false" for plain text only.
const USE_ATTACH = (process.env.BITRIX_USE_ATTACH || "true").toLowerCase() !== "false";
// Optional: skip noisy events, e.g. "docker-cleanup,dokploy-restart"
const IGNORE_TYPES = (process.env.IGNORE_TYPES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!BITRIX_WEBHOOK_URL || DIALOG_IDS.length === 0) {
  console.error("Missing BITRIX_WEBHOOK_URL or BITRIX_DIALOG_ID env vars.");
  process.exit(1);
}
if (!RELAY_SECRET) {
  console.warn("WARNING: RELAY_SECRET is not set - anyone who finds this URL can post to your chat.");
}

const COLORS = { success: "#2FC26E", error: "#E53935", alert: "#FFA000", info: "#2196F3" };
const ICONS = { success: "✅", error: "❌", alert: "⚠️", info: "ℹ️" };

// Strip Bitrix BBCode brackets from user-supplied text so it can't break formatting
const clean = (v) => String(v ?? "").replace(/\[/g, "(").replace(/\]/g, ")");
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

function statusOf(p) {
  if (p.status === "error" || p.type === "error") return "error";
  if (p.status === "alert") return "alert";
  if (p.status === "success") return "success";
  return "info";
}

// Map Dokploy's payload (see packages/server/src/utils/notifications/*.ts) to label/value pairs
// Timezone used to show the time in messages (Dokploy sends server time, usually UTC)
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

function formatTime(p) {
  const d = new Date(p.timestamp || Date.now());
  if (isNaN(d)) return p.date || "";
  try {
    return d.toLocaleString("en-IN", {
      timeZone: TIMEZONE, day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    });
  } catch {
    return d.toISOString();
  }
}

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

// Map Dokploy's payload (see packages/server/src/utils/notifications/*.ts) to label/value pairs
function fieldsOf(p) {
  const f = [];
  const add = (name, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") f.push([name, clean(value)]);
  };
  add("Project", p.projectName);
  add("Application", p.applicationName);
  add("Type", cap(p.applicationType || p.databaseType || p.serviceType));
  add("Database", p.databaseName);
  add("Volume", p.volumeName);
  add("Server", p.serverName);
  if (p.alertType === "server-threshold") {
    add("Metric", p.type);
    add("Current", p.currentValue);
    add("Threshold", p.threshold);
  }
  add("Domain", p.domains);
  if (p._commit?.message) {
    // With a hash it's a git push; without one it's e.g. "Manual deployment" / "Rebuild deployment"
    if (p._commit.hash) add("Commit", `${truncate(p._commit.message, 200)} (${p._commit.hash})`);
    else add("Trigger", truncate(p._commit.message, 200));
  }
  add("Backup", p.backupType);
  add("Size", p.backupSize);
  add("Details", p.cleanupMessage);
  add("Time", formatTime(p));
  return f;
}

// ---- Commit message lookup -------------------------------------------------
// Dokploy doesn't include the commit in its notification, but it stores it as the
// deployment title ("Hash: <sha>" in the description). We read the latest deployment
// through Dokploy's API using the service id found in buildLink.
// Needs DOKPLOY_API_KEY (Dokploy -> Profile -> API/CLI -> Generate). Optional.
const DOKPLOY_API_KEY = process.env.DOKPLOY_API_KEY || "";
const DOKPLOY_URL = (process.env.DOKPLOY_URL || "").replace(/\/+$/, "");

async function lookupCommit(p) {
  if (!DOKPLOY_API_KEY || typeof p.buildLink !== "string") return null;
  const m = p.buildLink.match(/\/services\/(application|compose)\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const base = DOKPLOY_URL || new URL(p.buildLink).origin;
  const url =
    m[1] === "application"
      ? `${base}/api/deployment.all?applicationId=${encodeURIComponent(m[2])}`
      : `${base}/api/deployment.allByCompose?composeId=${encodeURIComponent(m[2])}`;
  try {
    const res = await fetch(url, {
      headers: { "x-api-key": DOKPLOY_API_KEY, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    const latest = Array.isArray(list) ? list[0] : null;
    if (!latest) return null;
    const hash = (String(latest.description || "").match(/Hash:\s*([0-9a-f]{7,40})/i) || [])[1] || "";
    const message = String(latest.title || "").split("\n")[0].trim();
    return { message, hash: hash.slice(0, 7) };
  } catch (e) {
    console.warn(`commit lookup failed: ${e.message}`);
    return null;
  }
}

function buildBitrixMessage(p, dialogId) {
  const st = statusOf(p);
  const title = clean(p.title || "Dokploy notification");
  const fields = fieldsOf(p);
  const error = p.errorMessage ? truncate(clean(p.errorMessage), 1500) : "";

  // One "Label: value" per line - renders cleanly on desktop and mobile
  const lines = fields.map(([k, v]) => `[B]${k}:[/B] ${v}`).join("\n");

  // Title line (also what shows in push notifications)
  let text = `${ICONS[st]} [B]${title}[/B]`;
  if (!USE_ATTACH) {
    if (p.message) text += `\n${clean(p.message)}`;
    if (lines) text += `\n\n${lines}`;
    if (error) text += `\n\n[B]Error:[/B]\n[CODE]${error}[/CODE]`;
  }

  const body = { DIALOG_ID: dialogId, MESSAGE: text, URL_PREVIEW: "N" };

  if (USE_ATTACH) {
    const blocks = [];
    if (p.message) blocks.push({ MESSAGE: `[I]${clean(p.message)}[/I]` });
    if (lines) blocks.push({ MESSAGE: lines });
    if (error) {
      blocks.push({ DELIMITER: { SIZE: 200, COLOR: "#c6c6c6" } });
      blocks.push({ MESSAGE: `[B]Error:[/B]\n${error}` });
    }
    body.ATTACH = { ID: 1, COLOR: COLORS[st], BLOCKS: blocks };
  }
  return body;
}

async function sendToBitrix(body) {
  const res = await fetch(`${BITRIX_WEBHOOK_URL}/im.message.add.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Bitrix24 error ${res.status}: ${data.error || ""} ${data.error_description || ""}`.trim());
  }
  return data.result;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const isBuild = (p) => p.type === "build";

const reply = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ok: true });
  if (req.method !== "POST" || !req.url.startsWith("/dokploy")) return reply(res, 404, { error: "not found" });

  if (RELAY_SECRET && req.headers["x-relay-secret"] !== RELAY_SECRET) {
    return reply(res, 401, { error: "unauthorized" });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return reply(res, 400, { error: "invalid JSON" });
  }

  if (payload.type && IGNORE_TYPES.includes(payload.type)) {
    return reply(res, 200, { ok: true, skipped: payload.type });
  }

  if (isBuild(payload)) payload._commit = await lookupCommit(payload);

  try {
    const ids = await Promise.all(DIALOG_IDS.map((d) => sendToBitrix(buildBitrixMessage(payload, d))));
    console.log(`[${new Date().toISOString()}] sent "${payload.title}" -> ${DIALOG_IDS.join(",")} (msg ${ids.join(",")})`);
    return reply(res, 200, { ok: true, messageIds: ids });
  } catch (e) {
    console.error(`[${new Date().toISOString()}] failed "${payload.title}": ${e.message}`);
    // 502 makes Dokploy's "Test" button show the failure
    return reply(res, 502, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Dokploy -> Bitrix24 relay listening on :${PORT}, chats: ${DIALOG_IDS.join(",")}`));

module.exports = { buildBitrixMessage };