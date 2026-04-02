var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

const RAW_BASE = "https://raw.githubusercontent.com/otakusyncnet/calendar-feed/main";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json; charset=UTF-8" } });
}
__name(json, "json");

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=UTF-8" } });
}
__name(html, "html");

function normalizeEmail(e) { return String(e || "").trim().toLowerCase(); }
__name(normalizeEmail, "normalizeEmail");

function emailKey(e) { return "email:" + normalizeEmail(e).replace(/[^a-zA-Z0-9]/g, "_"); }
__name(emailKey, "emailKey");

function tokenKey(t) { return "token:" + t; }
__name(tokenKey, "tokenKey");

function subKey(t) { return "sub:" + t; }
__name(subKey, "subKey");

function makeToken() { return crypto.randomUUID().replace(/-/g, "").slice(0, 16); }
__name(makeToken, "makeToken");

function guessContentType(path) {
  if (path.endsWith(".html")) return "text/html; charset=UTF-8";
  if (path.endsWith(".ics"))  return "text/calendar; charset=UTF-8";
  if (path.endsWith(".js"))   return "application/javascript; charset=UTF-8";
  if (path.endsWith(".css"))  return "text/css; charset=UTF-8";
  if (path.endsWith(".json")) return "application/json; charset=UTF-8";
  if (path.endsWith(".png"))  return "image/png";
  if (path.endsWith(".svg"))  return "image/svg+xml";
  return "text/plain; charset=UTF-8";
}
__name(guessContentType, "guessContentType");

async function fetchRaw(path) {
  return fetch(RAW_BASE + path, { headers: { "User-Agent": "OtakuSync-Worker" } });
}
__name(fetchRaw, "fetchRaw");

async function proxyRawFile(path) {
  const resp = await fetchRaw(path);
  if (!resp.ok) return new Response("Not found", { status: 404 });
  return new Response(await resp.text(), {
    status: 200,
    headers: { "Content-Type": guessContentType(path), "Cache-Control": "max-age=60" },
  });
}
__name(proxyRawFile, "proxyRawFile");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

      // Admin page — served from GitHub
      if (path === "/admin" || path === "/admin/") return proxyRawFile("/admin.html");

      if (path.startsWith("/admin/api/")) return handleAdminAPI(request, env, path, url);
      if (path === "/api/signup" && request.method === "POST") return handleSignup(request, env, url);
      if (path.startsWith("/feed/") && path.endsWith(".ics")) return handleTokenFeed(request, env, url);
      if (path.startsWith("/feeds/") && path.endsWith(".ics")) return proxyRawFile(path);
      if (path === "/" || path === "/index.html") return proxyRawFile("/index.html");
      if (path === "/subscribe" || path === "/signup" || path === "/subscribe.html") return proxyRawFile("/subscribe.html");
      if (path === "/thankyou" || path === "/thankyou.html") return proxyRawFile("/thankyou.html");
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return new Response("Server error: " + err.message, { status: 500 });
    }
  },
};

async function handleSignup(request, env, url) {
  if (!env.ANIME_CAL) return json({ error: "KV binding missing" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const email = normalizeEmail(body.email);
  const feeds = Array.isArray(body.feeds) && body.feeds.length ? body.feeds : ["master"];
  if (!email || !email.includes("@")) return json({ error: "Valid email required" }, 400);
  const existingRaw = await env.ANIME_CAL.get(emailKey(email));
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    return json({ success: true, existing: true, token: existing.token, feeds: existing.feeds || ["master"] });
  }
  const token = makeToken();
  const now = new Date().toISOString();
  await env.ANIME_CAL.put(emailKey(email), JSON.stringify({ email, feeds, token, created: now, source: "subscribe_page", syncCount: 0, lastSync: null, status: "active" }));
  await env.ANIME_CAL.put(tokenKey(token), email);
  await env.ANIME_CAL.put(subKey(token), JSON.stringify({ token, email, note: "Self-signup", feeds, created: now, status: "active", lastSync: null, syncCount: 0 }));
  return json({ success: true, existing: false, token, feeds });
}
__name(handleSignup, "handleSignup");

async function handleTokenFeed(request, env, url) {
  if (!env.ANIME_CAL) return new Response("KV binding missing.", { status: 503 });
  const filename = url.pathname.split("/").pop();
  const parts = filename.replace(/\.ics$/i, "").split("_");
  if (parts.length < 2) return new Response("Invalid feed link.", { status: 400 });
  const token = parts[0];
  const feedName = ["master","crunchyroll","netflix","hidive","manga","manhwa","manhua"].includes(parts.slice(1).join("_")) ? parts.slice(1).join("_") : "master";
  const mappedEmail = await env.ANIME_CAL.get(tokenKey(token));
  if (!mappedEmail) return new Response("Invalid subscription link.", { status: 403 });
  const recRaw = await env.ANIME_CAL.get(emailKey(mappedEmail));
  if (!recRaw) return new Response("Subscription not found.", { status: 403 });
  const rec = JSON.parse(recRaw);
  if (rec.status && rec.status !== "active") return new Response("Subscription deactivated.", { status: 403 });
  const feedResp = await fetchRaw("/feeds/" + feedName + ".ics");
  if (!feedResp.ok) return new Response("Calendar unavailable.", { status: 503 });
  const now = new Date().toISOString();
  rec.lastSync = now; rec.syncCount = (rec.syncCount || 0) + 1;
  await env.ANIME_CAL.put(emailKey(mappedEmail), JSON.stringify(rec));
  const subRaw = await env.ANIME_CAL.get(subKey(token));
  if (subRaw) {
    const sub = JSON.parse(subRaw);
    sub.lastSync = now; sub.syncCount = (sub.syncCount || 0) + 1;
    await env.ANIME_CAL.put(subKey(token), JSON.stringify(sub));
  }
  return new Response(await feedResp.text(), { status: 200, headers: { "Content-Type": "text/calendar; charset=UTF-8", "Cache-Control": "max-age=3600" } });
}
__name(handleTokenFeed, "handleTokenFeed");

async function handleAdminAPI(request, env, path, url) {
  if (!env.ANIME_CAL) return json({ error: "KV binding missing" }, 503);
  // Password comes from Cloudflare Secrets Store
  if (!env.ADMIN_PASSWORD) return json({ error: "Admin password not configured" }, 503);
  const pw = request.headers.get("X-Admin-Password");
  if (pw !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized" }, 401);

  if (path === "/admin/api/stats" && request.method === "GET") {
    const [subsList, emailsList] = await Promise.all([env.ANIME_CAL.list({ prefix: "sub:" }), env.ANIME_CAL.list({ prefix: "email:" })]);
    const subs = (await Promise.all(subsList.keys.map(async k => { const v = await env.ANIME_CAL.get(k.name); return v ? JSON.parse(v) : null; }))).filter(Boolean);
    return json({ totalSubscribers: subs.length, activeSubscribers: subs.filter(s => s.status === "active").length, inactiveSubscribers: subs.filter(s => s.status !== "active").length, totalSyncs: subs.reduce((a, s) => a + (s.syncCount || 0), 0), totalEmails: emailsList.keys.length });
  }
  if (path === "/admin/api/subscribers" && request.method === "GET") {
    const list = await env.ANIME_CAL.list({ prefix: "sub:" });
    const subs = (await Promise.all(list.keys.map(async k => { const v = await env.ANIME_CAL.get(k.name); return v ? JSON.parse(v) : null; }))).filter(Boolean);
    return json({ subscribers: subs.sort((a, b) => String(b.created || "").localeCompare(String(a.created || ""))) });
  }
  if (path === "/admin/api/subscribers" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
    const token = makeToken(); const now = new Date().toISOString();
    const email = normalizeEmail(body.email || ""); const note = String(body.note || "").trim();
    const feeds = Array.isArray(body.feeds) && body.feeds.length ? body.feeds : ["master"];
    const sub = { token, email, note, feeds, created: now, status: "active", lastSync: null, syncCount: 0 };
    await env.ANIME_CAL.put(subKey(token), JSON.stringify(sub));
    if (email) { await env.ANIME_CAL.put(emailKey(email), JSON.stringify({ email, feeds, token, created: now, source: "admin_create", syncCount: 0, lastSync: null, status: "active" })); await env.ANIME_CAL.put(tokenKey(token), email); }
    return json({ success: true, subscriber: sub, feedUrl: "https://" + url.hostname + "/feed/" + token + "_master.ics" });
  }
  const subMatch = path.match(/^\/admin\/api\/subscribers\/([^/]+)$/);
  if (subMatch && request.method === "PATCH") {
    const token = subMatch[1]; const existing = await env.ANIME_CAL.get(subKey(token));
    if (!existing) return json({ error: "Not found" }, 404);
    let body; try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
    const updated = { ...JSON.parse(existing), ...body, token: JSON.parse(existing).token };
    await env.ANIME_CAL.put(subKey(token), JSON.stringify(updated));
    return json({ success: true, subscriber: updated });
  }
  if (subMatch && request.method === "DELETE") {
    const token = subMatch[1]; const existing = await env.ANIME_CAL.get(subKey(token));
    if (existing) { const sub = JSON.parse(existing); if (sub.email) { await env.ANIME_CAL.delete(emailKey(sub.email)); await env.ANIME_CAL.delete(tokenKey(token)); } }
    await env.ANIME_CAL.delete(subKey(token));
    return json({ success: true });
  }
  if (path === "/admin/api/emails" && request.method === "GET") {
    const list = await env.ANIME_CAL.list({ prefix: "email:" });
    const emails = (await Promise.all(list.keys.map(async k => { const v = await env.ANIME_CAL.get(k.name); return v ? JSON.parse(v) : null; }))).filter(Boolean);
    return json({ emails: emails.sort((a, b) => String(b.created || "").localeCompare(String(a.created || ""))), count: emails.length });
  }
  if (path === "/admin/api/emails/export" && request.method === "GET") {
    const list = await env.ANIME_CAL.list({ prefix: "email:" });
    const emails = (await Promise.all(list.keys.map(async k => { const v = await env.ANIME_CAL.get(k.name); return v ? JSON.parse(v) : null; }))).filter(Boolean);
    const rows = [["Email","Feeds","Created","Last Sync","Sync Count","Status","Token"], ...emails.map(e => [e.email||"",(e.feeds||[]).join("|"),e.created||"",e.lastSync||"",e.syncCount||0,e.status||"",e.token||""])];
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(",")).join("\n");
    return new Response(csv, { status: 200, headers: { ...CORS, "Content-Type": "text/csv; charset=UTF-8", "Content-Disposition": 'attachment; filename="otakusync-emails.csv"' } });
  }
  return json({ error: "Not found" }, 404);
}
__name(handleAdminAPI, "handleAdminAPI");
`*_
