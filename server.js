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
function fieldsOf(p) {
  const f = [];
  const add = (name, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") f.push([name, clean(value)]);
  };
  add("Project", p.projectName);
  add("Application", p.applicationName);
  add("Type", p.applicationType || p.databaseType || p.serviceType);
  add("Database", p.databaseName);
  add("Volume", p.volumeName);
  add("Server", p.serverName);
  if (p.alertType === "server-threshold") {
    add("Metric", p.type);
    add("Current", p.currentValue);
    add("Threshold", p.threshold);
  }
  add("Domains", p.domains);
  add("Backup", p.backupType);
  add("Size", p.backupSize);
  add("Details", p.cleanupMessage);
  add("Time", p.date || p.timestamp);
  return f;
}

function buildBitrixMessage(p, dialogId) {
  const st = statusOf(p);
  const title = clean(p.title || "Dokploy notification");
  const fields = fieldsOf(p);
  const error = p.errorMessage ? truncate(clean(p.errorMessage), 1500) : "";
  const link = typeof p.buildLink === "string" && /^https?:\/\//.test(p.buildLink) ? p.buildLink : "";

  // Plain-text body (always sent: shows in push notifications and as a fallback)
  let text = `${ICONS[st]} [B]${title}[/B]`;
  if (p.message && !USE_ATTACH) text += `\n${clean(p.message)}`;
  if (!USE_ATTACH) {
    for (const [k, v] of fields) text += `\n[B]${k}:[/B] ${v}`;
    if (error) text += `\n[B]Error:[/B]\n[CODE]${error}[/CODE]`;
    if (link) text += `\n[URL=${link}]Open in Dokploy[/URL]`;
  }

  const body = { DIALOG_ID: dialogId, MESSAGE: text, URL_PREVIEW: "N" };

  if (USE_ATTACH) {
    const blocks = [];
    if (p.message) blocks.push({ MESSAGE: clean(p.message) });
    if (fields.length) {
      blocks.push({ GRID: fields.map(([NAME, VALUE]) => ({ NAME, VALUE, DISPLAY: "LINE", WIDTH: 110 })) });
    }
    if (error) {
      blocks.push({ DELIMITER: { SIZE: 200, COLOR: "#c6c6c6" } });
      blocks.push({ MESSAGE: `[B]Error:[/B]\n${error}` });
    }
    if (link) blocks.push({ LINK: { NAME: "Open in Dokploy", LINK: link } });
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