import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const MCP_ENDPOINT = process.env.SERENT_COMMAND_CENTER_MCP_ENDPOINT || "https://codex-mcp.kindmeadow-a8b05e72.westus3.azurecontainerapps.io/mcp";
const TOKEN_STORE = process.env.SERENT_COMMAND_CENTER_TOKEN_STORE || path.join(homedir(), ".codex", "serent_tokens.json");
let memoryToken = "";
let memoryTokenExpires = 0;

export function clearSerentTokenCache() { memoryToken = ""; memoryTokenExpires = 0; }

function walk(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return [value, ...Object.values(value).flatMap((child) => walk(child, seen))];
}

function findTokenRecord(store) {
  return walk(store).find((item) => typeof item.access_token === "string") ||
    walk(store).find((item) => typeof item.accessToken === "string") || null;
}

function expiryMs(record) {
  const raw = record?.expires_at || record?.expiresAt || record?.expires_on || record?.expiresOn || record?.expiration;
  if (!raw) return 0;
  if (typeof raw === "number") return raw < 10_000_000_000 ? raw * 1000 : raw;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jwtExpiry(token) {
  try { const value = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); return value.exp ? Number(value.exp) * 1000 : 0; } catch { return 0; }
}

export async function getSerentAccessToken() {
  if (memoryToken && memoryTokenExpires - Date.now() > 60_000) return memoryToken;
  const raw = (await readFile(TOKEN_STORE, "utf8")).replace(/^\uFEFF/, "");
  const record = findTokenRecord(JSON.parse(raw));
  if (!record) throw new Error("Serent token store has no access-token record.");
  const current = record.access_token || record.accessToken || record.token;
  const expires = expiryMs(record) || jwtExpiry(current);
  if (current && (!expires || expires - Date.now() > 60_000)) { memoryToken = current; memoryTokenExpires = expires || Date.now() + 5 * 60_000; return current; }

  const refreshToken = record.refresh_token || record.refreshToken;
  const clientId = record.client_id || record.clientId;
  const rawEndpoint = record.token_endpoint || record.tokenEndpoint || record.issuer || record.authority;
  if (!refreshToken || !clientId || !rawEndpoint) throw new Error("Serent Microsoft token needs refresh.");
  const tokenEndpoint = rawEndpoint.includes("/token") ? rawEndpoint : `${rawEndpoint.replace(/\/$/, "")}/oauth2/v2.0/token`;
  const body = new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken });
  if (record.scope) body.set("scope", record.scope);
  const response = await fetch(tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`Serent token refresh failed with HTTP ${response.status}.`);
  const refreshed = await response.json();
  if (!refreshed.access_token) throw new Error("Serent token refresh returned no access token.");
  memoryToken = refreshed.access_token;
  memoryTokenExpires = Date.now() + Number(refreshed.expires_in || 3600) * 1000;
  return memoryToken;
}

async function graphRequest(url) {
  const token = await getSerentAccessToken();
  const response = await fetch(url.startsWith("http") ? url : `${GRAPH_ROOT}${url}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Microsoft mail read failed with HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

function tokenAudience(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).aud || ""; } catch { return ""; }
}

function parseRemoteResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
    return lines.length ? JSON.parse(lines.at(-1)) : null;
  }
  return JSON.parse(trimmed);
}

async function mcpCall(name, args) {
  const token = await getSerentAccessToken();
  const response = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Serent mail route returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  const payload = parseRemoteResponse(text);
  if (payload?.error) throw new Error(payload.error.message || "Serent mail route failed.");
  const blocks = Array.isArray(payload?.result?.content) ? payload.result.content : [];
  for (const block of blocks) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try { return JSON.parse(block.text); } catch { /* Try the next content block. */ }
  }
  return payload?.result || {};
}

async function paged(pathname, maxPages = 50) {
  const items = [];
  let next = pathname;
  let pages = 0;
  while (next && pages < maxPages) {
    const payload = await graphRequest(next);
    items.push(...(Array.isArray(payload.value) ? payload.value : []));
    next = payload["@odata.nextLink"] || "";
    pages += 1;
  }
  return { items, pages, complete: !next };
}

const MESSAGE_FIELDS = [
  "id", "subject", "from", "toRecipients", "ccRecipients", "receivedDateTime", "sentDateTime",
  "bodyPreview", "webLink", "isRead", "hasAttachments", "importance", "conversationId", "internetMessageId",
].join(",");

function mailPath(folder, filter) {
  const params = new URLSearchParams({ "$select": MESSAGE_FIELDS, "$orderby": folder === "sentitems" ? "sentDateTime desc" : "receivedDateTime desc", "$top": "100" });
  if (filter) params.set("$filter", filter);
  return `/me/mailFolders/${folder}/messages?${params.toString()}`;
}

export async function fetchActiveMail({ sinceIso }) {
  const token = await getSerentAccessToken();
  const audience = String(tokenAudience(token));
  const graphAudience = audience === "00000003-0000-0000-c000-000000000000" || audience.includes("graph.microsoft.com");
  if (!graphAudience) {
    const [inboxPayload, sentPayload] = await Promise.all([
      mcpCall("list_my_inbox_messages", { since_utc: sinceIso, top: 100, include_body: false }),
      mcpCall("list_my_folder_messages", { folder_id: "sentitems", since_utc: sinceIso, top: 100, include_body: false }),
    ]);
    const convert = (item, sent = false) => ({
      id: item.id,
      subject: item.subject || "(No subject)",
      from: { emailAddress: { name: item.sender?.name || "", address: item.sender?.email || "" } },
      toRecipients: [], ccRecipients: [],
      receivedDateTime: item.received || item.sent || "",
      sentDateTime: sent ? (item.sent || item.received || "") : "",
      bodyPreview: item.body_preview || "",
      webLink: item.web_link || "",
      isRead: null,
      hasAttachments: false,
      importance: "normal",
      conversationId: item.conversation_id || "",
      internetMessageId: item.internet_message_id || "",
    });
    const inboxItems = Array.isArray(inboxPayload.items) ? inboxPayload.items : [];
    const sentItems = Array.isArray(sentPayload.items) ? sentPayload.items : [];
    return { inbox: inboxItems.map((item) => convert(item)), sent: sentItems.map((item) => convert(item, true)), coverage: { pages: 2, complete: inboxItems.length < 100 && sentItems.length < 100, route: "serent_mcp" } };
  }
  const [recent, unread, sent] = await Promise.all([
    paged(mailPath("inbox", `receivedDateTime ge ${sinceIso}`)),
    paged(mailPath("inbox", "isRead eq false")),
    paged(mailPath("sentitems", `sentDateTime ge ${sinceIso}`)),
  ]);
  const inbox = new Map();
  for (const item of [...recent.items, ...unread.items]) inbox.set(item.id, item);
  return {
    inbox: [...inbox.values()],
    sent: sent.items,
    coverage: { pages: recent.pages + unread.pages + sent.pages, complete: recent.complete && unread.complete && sent.complete },
  };
}

export async function fetchCalendarEvents({ startIso, endIso }) {
  const payload = await mcpCall("list_my_calendar_events", { start_utc: startIso, end_utc: endIso, top: 100 });
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function fetchMailBody(messageId) {
  const token = await getSerentAccessToken();
  const audience = String(tokenAudience(token));
  if (!(audience === "00000003-0000-0000-c000-000000000000" || audience.includes("graph.microsoft.com"))) {
    const payload = await mcpCall("get_my_message", { message_id: messageId, include_body: true });
    const item = payload.message || payload;
    return { ...item, body: { contentType: "text", content: item.body || item.body_text || "" } };
  }
  const params = new URLSearchParams({ "$select": `${MESSAGE_FIELDS},body` });
  return graphRequest(`/me/messages/${encodeURIComponent(messageId)}?${params.toString()}`);
}

export async function fetchMailAttachments(messageId) {
  const token = await getSerentAccessToken();
  const audience = String(tokenAudience(token));
  if (!(audience === "00000003-0000-0000-c000-000000000000" || audience.includes("graph.microsoft.com"))) {
    const payload = await mcpCall("list_my_message_attachments", { message_id: messageId, top: 50 });
    return Array.isArray(payload.items) ? payload.items : Array.isArray(payload.attachments) ? payload.attachments : [];
  }
  const params = new URLSearchParams({ "$select": "id,name,contentType,size,isInline", "$top": "100" });
  const payload = await paged(`/me/messages/${encodeURIComponent(messageId)}/attachments?${params.toString()}`, 10);
  return payload.items;
}

export function htmlToText(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
