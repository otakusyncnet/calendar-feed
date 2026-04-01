const RAW_BASE = "https://raw.githubusercontent.com/otakusyncnet/calendar-feed/main";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
    },
  });
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function emailKey(email) {
  return "email:" + normalizeEmail(email).replace(/[^a-zA-Z0-9]/g, "_");
}

function tokenKey(token) {
  return "token:" + token;
}

function subKey(token) {
  return "sub:" + token;
}

function makeToken() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function guessContentType(path) {
  if (path.endsWith(".html")) return "text/html; charset=UTF-8";
  if (path.endsWith(".css")) return "text/css; charset=UTF-8";
  if (path.endsWith(".js")) return "application/javascript; charset=UTF-8";
  if (path.endsWith(".json")) return "application/json; charset=UTF-8";
  if (path.endsWith(".ics")) return "text/calendar; charset=UTF-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "text/plain; charset=UTF-8";
}

function rawUrl(path) {
  return RAW_BASE + path;
}

async function fetchRaw(path) {
  return fetch(rawUrl(path), {
    headers: { "User-Agent": "OtakuSync-Worker" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: CORS });
      }

      if (path === "/admin" || path === "/admin/") {
        return html(ADMIN_HTML);
      }

      if (path.startsWith("/admin/api/")) {
        return handleAdminAPI(request, env, path, url);
      }

      if (path === "/api/signup" && request.method === "POST") {
        return handleSignup(request, env, url);
      }

      if (path.startsWith("/feed/") && path.endsWith(".ics")) {
        return handleTokenFeed(request, env, url);
      }

      if (path.startsWith("/feeds/") && path.endsWith(".ics")) {
        return proxyRawFile(path);
      }

      if (path === "/" || path === "/index.html") {
        return proxyRawFile("/index.html");
      }

      if (path === "/subscribe" || path === "/signup" || path === "/subscribe.html") {
        return proxyRawFile("/subscribe.html");
      }

      if (path === "/thankyou" || path === "/thankyou.html") {
        return proxyRawFile("/thankyou.html");
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return new Response("Server error: " + err.message, { status: 500 });
    }
  },
};

async function proxyRawFile(path) {
  const resp = await fetchRaw(path);

  if (!resp.ok) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(await resp.arrayBuffer(), {
    status: 200,
    headers: {
      "Content-Type": resp.headers.get("content-type") || guessContentType(path),
      "Cache-Control": "max-age=300",
    },
  });
}

async function handleSignup(request, env, url) {
  if (!env.ANIME_CAL) {
    return json({ error: "KV binding ANIME_CAL is missing." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const email = normalizeEmail(body.email);
  const feeds = Array.isArray(body.feeds) && body.feeds.length ? body.feeds : ["master"];

  if (!email || !email.includes("@")) {
    return json({ error: "Valid email required" }, 400);
  }

  const existingRaw = await env.ANIME_CAL.get(emailKey(email));
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    return json({
      success: true,
      existing: true,
      token: existing.token,
      feeds: existing.feeds || ["master"],
      feedUrl: `https://${url.hostname}/feed/${existing.token}_master.ics`,
    });
  }

  const token = makeToken();
  const now = new Date().toISOString();

  const emailRecord = {
    email,
    feeds,
    token,
    created: now,
    source: "subscribe_page",
    syncCount: 0,
    lastSync: null,
    status: "active",
  };

  const subscriberRecord = {
    token,
    email,
    note: "Self-signup",
    feeds,
    created: now,
    status: "active",
    lastSync: null,
    syncCount: 0,
  };

  await env.ANIME_CAL.put(emailKey(email), JSON.stringify(emailRecord));
  await env.ANIME_CAL.put(tokenKey(token), email);
  await env.ANIME_CAL.put(subKey(token), JSON.stringify(subscriberRecord));

  return json({
    success: true,
    existing: false,
    token,
    feeds,
    feedUrl: `https://${url.hostname}/feed/${token}_master.ics`,
  });
}

async function handleTokenFeed(request, env, url) {
  if (!env.ANIME_CAL) {
    return new Response("KV binding ANIME_CAL is missing.", { status: 503 });
  }

  const filename = url.pathname.split("/").pop();
  const name = filename.replace(/\.ics$/i, "");
  const parts = name.split("_");

  if (parts.length < 2) {
    return new Response("Invalid feed link.", { status: 400 });
  }

  const token = parts[0];
  const requestedFeed = parts.slice(1).join("_");

  const validFeeds = new Set([
    "master",
    "crunchyroll",
    "netflix",
    "hidive",
    "manga",
    "manhwa",
    "manhua",
  ]);

  const feedName = validFeeds.has(requestedFeed) ? requestedFeed : "master";

  const mappedEmail = await env.ANIME_CAL.get(tokenKey(token));
  if (!mappedEmail) {
    return new Response("Invalid or expired subscription link.", { status: 403 });
  }

  const emailRecordRaw = await env.ANIME_CAL.get(emailKey(mappedEmail));
  if (!emailRecordRaw) {
    return new Response("Subscription record not found.", { status: 403 });
  }

  const emailRecord = JSON.parse(emailRecordRaw);
  if (emailRecord.status && emailRecord.status !== "active") {
    return new Response("This subscription has been deactivated.", { status: 403 });
  }

  const feedPath = `/feeds/${feedName}.ics`;
  const feedResp = await fetchRaw(feedPath);

  if (!feedResp.ok) {
    return new Response("Calendar temporarily unavailable.", { status: 503 });
  }

  const now = new Date().toISOString();

  emailRecord.lastSync = now;
  emailRecord.syncCount = (emailRecord.syncCount || 0) + 1;
  await env.ANIME_CAL.put(emailKey(mappedEmail), JSON.stringify(emailRecord));

  const subRaw = await env.ANIME_CAL.get(subKey(token));
  if (subRaw) {
    const sub = JSON.parse(subRaw);
    sub.lastSync = now;
    sub.syncCount = (sub.syncCount || 0) + 1;
    await env.ANIME_CAL.put(subKey(token), JSON.stringify(sub));
  }

  return new Response(await feedResp.text(), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=UTF-8",
      "Cache-Control": "max-age=3600",
    },
  });
}

async function handleAdminAPI(request, env, path, url) {
  if (!env.ANIME_CAL) {
    return json({ error: "KV binding ANIME_CAL is missing." }, 503);
  }

  if (!env.ADMIN_PASSWORD) {
    return json({ error: "ADMIN_PASSWORD secret is missing." }, 503);
  }

  const pw = request.headers.get("X-Admin-Password");
  if (pw !== env.ADMIN_PASSWORD) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (path === "/admin/api/stats" && request.method === "GET") {
    const [subsList, emailsList] = await Promise.all([
      env.ANIME_CAL.list({ prefix: "sub:" }),
      env.ANIME_CAL.list({ prefix: "email:" }),
    ]);

    const subs = await Promise.all(
      subsList.keys.map(async (k) => {
        const val = await env.ANIME_CAL.get(k.name);
        return val ? JSON.parse(val) : null;
      })
    );

    const filteredSubs = subs.filter(Boolean);

    return json({
      totalSubscribers: filteredSubs.length,
      activeSubscribers: filteredSubs.filter((s) => s.status === "active").length,
      inactiveSubscribers: filteredSubs.filter((s) => s.status !== "active").length,
      totalSyncs: filteredSubs.reduce((sum, s) => sum + (s.syncCount || 0), 0),
      totalEmails: emailsList.keys.length,
    });
  }

  if (path === "/admin/api/subscribers" && request.method === "GET") {
    const list = await env.ANIME_CAL.list({ prefix: "sub:" });
    const subs = await Promise.all(
      list.keys.map(async (k) => {
        const val = await env.ANIME_CAL.get(k.name);
        return val ? JSON.parse(val) : null;
      })
    );

    return json({
      subscribers: subs.filter(Boolean).sort((a, b) =>
        String(b.created || "").localeCompare(String(a.created || ""))
      ),
    });
  }

  if (path === "/admin/api/subscribers" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad JSON" }, 400);
    }

    const email = normalizeEmail(body.email || "");
    const note = String(body.note || "").trim();
    const feeds = Array.isArray(body.feeds) && body.feeds.length ? body.feeds : ["master"];
    const token = makeToken();
    const now = new Date().toISOString();

    const sub = {
      token,
      email,
      note,
      feeds,
      created: now,
      status: "active",
      lastSync: null,
      syncCount: 0,
    };

    await env.ANIME_CAL.put(subKey(token), JSON.stringify(sub));

    if (email) {
      await env.ANIME_CAL.put(
        emailKey(email),
        JSON.stringify({
          email,
          feeds,
          token,
          created: now,
          source: "admin_create",
          syncCount: 0,
          lastSync: null,
          status: "active",
        })
      );
      await env.ANIME_CAL.put(tokenKey(token), email);
    }

    return json({
      success: true,
      subscriber: sub,
      feedUrl: `https://${url.hostname}/feed/${token}_master.ics`,
    });
  }

  const subMatch = path.match(/^\/admin\/api\/subscribers\/([^/]+)$/);

  if (subMatch && request.method === "PATCH") {
    const token = subMatch[1];
    const existing = await env.ANIME_CAL.get(subKey(token));
    if (!existing) return json({ error: "Not found" }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad JSON" }, 400);
    }

    const current = JSON.parse(existing);
    const updated = { ...current, ...body, token: current.token };

    await env.ANIME_CAL.put(subKey(token), JSON.stringify(updated));

    if (updated.email) {
      const existingEmailRaw = await env.ANIME_CAL.get(emailKey(updated.email));
      const emailRecord = existingEmailRaw ? JSON.parse(existingEmailRaw) : {};
      await env.ANIME_CAL.put(
        emailKey(updated.email),
        JSON.stringify({
          ...emailRecord,
          email: updated.email,
          feeds: updated.feeds || emailRecord.feeds || ["master"],
          token,
          created: emailRecord.created || updated.created,
          source: emailRecord.source || "admin_update",
          syncCount: typeof updated.syncCount === "number" ? updated.syncCount : (emailRecord.syncCount || 0),
          lastSync: updated.lastSync ?? emailRecord.lastSync ?? null,
          status: updated.status || "active",
        })
      );
      await env.ANIME_CAL.put(tokenKey(token), updated.email);
    }

    return json({ success: true, subscriber: updated });
  }

  if (subMatch && request.method === "DELETE") {
    const token = subMatch[1];
    const existing = await env.ANIME_CAL.get(subKey(token));

    if (existing) {
      const sub = JSON.parse(existing);
      if (sub.email) {
        await env.ANIME_CAL.delete(emailKey(sub.email));
      }
      await env.ANIME_CAL.delete(tokenKey(token));
    }

    await env.ANIME_CAL.delete(subKey(token));
    return json({ success: true });
  }

  if (path === "/admin/api/emails" && request.method === "GET") {
    const list = await env.ANIME_CAL.list({ prefix: "email:" });
    const emails = await Promise.all(
      list.keys.map(async (k) => {
        const val = await env.ANIME_CAL.get(k.name);
        return val ? JSON.parse(val) : null;
      })
    );

    const filtered = emails.filter(Boolean).sort((a, b) =>
      String(b.created || "").localeCompare(String(a.created || ""))
    );

    return json({ emails: filtered, count: filtered.length });
  }

  if (path === "/admin/api/emails/export" && request.method === "GET") {
    const list = await env.ANIME_CAL.list({ prefix: "email:" });
    const emails = await Promise.all(
      list.keys.map(async (k) => {
        const val = await env.ANIME_CAL.get(k.name);
        return val ? JSON.parse(val) : null;
      })
    );

    const filtered = emails.filter(Boolean);

    const rows = [
      ["Email", "Feeds", "Created", "Last Sync", "Sync Count", "Status", "Token"],
      ...filtered.map((e) => [
        e.email || "",
        (e.feeds || []).join("|"),
        e.created || "",
        e.lastSync || "",
        e.syncCount || 0,
        e.status || "",
        e.token || "",
      ]),
    ];

    const csv = rows
      .map((row) => row.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(","))
      .join("\\n");

    return new Response(csv, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "text/csv; charset=UTF-8",
        "Content-Disposition": 'attachment; filename="otakusync-emails.csv"',
      },
    });
  }

  return json({ error: "Not found" }, 404);
}

const ADMIN_HTML = \`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<title>OtakuSync Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d0d1a;color:#e5e7eb;min-height:100vh}
.wrap{max-width:1100px;margin:0 auto;padding:24px}
.header{margin-bottom:20px}
.header h1{font-size:28px;color:white}
.header p{color:#9ca3af;margin-top:6px}
.card{background:#17172a;border:1px solid #2a2a44;border-radius:16px;padding:20px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:18px}
.stat{background:#111122;border:1px solid #2a2a44;border-radius:14px;padding:18px;text-align:center}
.stat .num{font-size:32px;font-weight:800;color:#34d399}
.stat .label{margin-top:6px;color:#9ca3af;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
input,button{font:inherit}
input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #374151;background:#0b1020;color:white}
.row{display:flex;gap:10px;flex-wrap:wrap}
.row>*{flex:1;min-width:180px}
button{padding:12px 16px;border:0;border-radius:10px;cursor:pointer;font-weight:700}
.btn-primary{background:#34d399;color:#08110f}
.btn-danger{background:#ef4444;color:white}
.btn-muted{background:#374151;color:white}
.btn-warn{background:#f59e0b;color:black}
.small-btn{padding:8px 10px;border-radius:8px;font-size:12px}
.hidden{display:none}
.error{margin-top:12px;padding:10px 12px;border-radius:10px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.4);color:#fca5a5}
.success{margin-top:12px;padding:10px 12px;border-radius:10px;background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.4);color:#86efac}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:10px;border-bottom:1px solid #2a2a44;vertical-align:top}
th{color:#9ca3af;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.table-wrap{overflow-x:auto}
.badge{display:inline-block;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:700}
.active{background:rgba(52,211,153,.12);color:#86efac}
.inactive{background:rgba(239,68,68,.12);color:#fca5a5}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;color:#93c5fd}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>OtakuSync Admin</h1>
    <p>Subscription manager</p>
  </div>

  <div class="card" id="loginCard">
    <div class="row">
      <input type="password" id="pw" placeholder="Admin password" autocomplete="current-password" />
      <button class="btn-primary" onclick="login()">Login</button>
    </div>
    <div id="loginError" class="error hidden"></div>
  </div>

  <div id="app" class="hidden">
    <div class="grid">
      <div class="stat"><div class="num" id="sTotal">0</div><div class="label">Total Subs</div></div>
      <div class="stat"><div class="num" id="sActive">0</div><div class="label">Active</div></div>
      <div class="stat"><div class="num" id="sInactive">0</div><div class="label">Inactive</div></div>
      <div class="stat"><div class="num" id="sSyncs">0</div><div class="label">Total Syncs</div></div>
      <div class="stat"><div class="num" id="sEmails">0</div><div class="label">Email Records</div></div>
    </div>

    <div class="card">
      <h2 style="margin-bottom:12px;">Create Subscriber</h2>
      <div class="row">
        <input type="email" id="newEmail" placeholder="Email" />
        <input type="text" id="newNote" placeholder="Note" />
        <button class="btn-primary" onclick="createSubscriber()">Generate Link</button>
      </div>
      <div id="createResult" class="success hidden"></div>
    </div>

    <div class="card">
      <div class="row" style="align-items:center;">
        <div style="font-weight:700;">Subscribers</div>
        <button class="btn-muted" onclick="refreshAll()">Refresh</button>
        <button class="btn-muted" onclick="exportEmails()">Export Emails CSV</button>
      </div>

      <div class="table-wrap" style="margin-top:14px;">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Note</th>
              <th>Created</th>
              <th>Last Sync</th>
              <th>Syncs</th>
              <th>Status</th>
              <th>Master Feed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="subTable">
            <tr><td colspan="8">No data yet.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<script>
let PW = "";

function setLoginError(msg){
  const el=document.getElementById("loginError");
  el.textContent=msg;
  el.classList.remove("hidden");
}

function clearLoginError(){
  document.getElementById("loginError").classList.add("hidden");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Password": PW,
      ...(options.headers || {})
    }
  });

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) throw new Error((data && data.error) || "Request failed");
  return data;
}

async function login(){
  PW=document.getElementById("pw").value.trim();
  clearLoginError();
  if(!PW){setLoginError("Enter your admin password.");return;}
  try{
    await refreshAll();
    document.getElementById("loginCard").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
  }catch(err){
    setLoginError(err.message || "Login failed.");
  }
}

async function refreshAll(){
  const [stats, subs] = await Promise.all([
    api("/admin/api/stats"),
    api("/admin/api/subscribers")
  ]);

  document.getElementById("sTotal").textContent = stats.totalSubscribers || 0;
  document.getElementById("sActive").textContent = stats.activeSubscribers || 0;
  document.getElementById("sInactive").textContent = stats.inactiveSubscribers || 0;
  document.getElementById("sSyncs").textContent = stats.totalSyncs || 0;
  document.getElementById("sEmails").textContent = stats.totalEmails || 0;

  renderSubscribers(subs.subscribers || []);
}

function renderSubscribers(subscribers){
  const tbody=document.getElementById("subTable");
  if(!subscribers.length){
    tbody.innerHTML='<tr><td colspan="8">No subscribers found.</td></tr>';
    return;
  }

  tbody.innerHTML = subscribers.map(sub => {
    const status = sub.status === "active" ? "active" : "inactive";
    const masterUrl = location.origin + "/feed/" + sub.token + "_master.ics";
    return \`
      <tr>
        <td>\${escapeHtml(sub.email || "")}</td>
        <td>\${escapeHtml(sub.note || "")}</td>
        <td>\${escapeHtml(sub.created || "")}</td>
        <td>\${escapeHtml(sub.lastSync || "")}</td>
        <td>\${sub.syncCount || 0}</td>
        <td><span class="badge \${status}">\${escapeHtml(sub.status || "inactive")}</span></td>
        <td class="mono">\${escapeHtml(masterUrl)}</td>
        <td>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="small-btn btn-muted" onclick="copyText('\${masterUrl}')">Copy</button>
            \${sub.status === "active"
              ? '<button class="small-btn btn-warn" onclick="setStatus(\\'' + sub.token + '\\', \\'inactive\\')">Pause</button>'
              : '<button class="small-btn btn-primary" onclick="setStatus(\\'' + sub.token + '\\', \\'active\\')">Activate</button>'}
            <button class="small-btn btn-danger" onclick="deleteSubscriber('\${sub.token}')">Delete</button>
          </div>
        </td>
      </tr>\`;
  }).join("");
}

async function createSubscriber(){
  const email=document.getElementById("newEmail").value.trim();
  const note=document.getElementById("newNote").value.trim();
  const result=document.getElementById("createResult");
  result.className="success hidden";
  result.textContent="";

  try{
    const data = await api("/admin/api/subscribers", {
      method: "POST",
      body: JSON.stringify({ email, note, feeds: ["master"] })
    });

    const feedUrl = location.origin + "/feed/" + data.subscriber.token + "_master.ics";
    result.textContent = "Created. Master feed: " + feedUrl;
    result.className = "success";
    result.classList.remove("hidden");
    document.getElementById("newEmail").value = "";
    document.getElementById("newNote").value = "";
    await refreshAll();
  }catch(err){
    result.textContent = err.message || "Could not create subscriber.";
    result.className = "error";
    result.classList.remove("hidden");
  }
}

async function setStatus(token, status){
  try{
    await api("/admin/api/subscribers/" + encodeURIComponent(token), {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
    await refreshAll();
  }catch(err){
    alert(err.message || "Update failed.");
  }
}

async function deleteSubscriber(token){
  if(!confirm("Delete this subscriber?")) return;
  try{
    await api("/admin/api/subscribers/" + encodeURIComponent(token), { method: "DELETE" });
    await refreshAll();
  }catch(err){
    alert(err.message || "Delete failed.");
  }
}

async function exportEmails(){
  const res = await fetch("/admin/api/emails/export", {
    headers: { "X-Admin-Password": PW }
  });
  if(!res.ok){ alert("Export failed."); return; }

  const blob = await res.blob();
  const dlUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = dlUrl;
  a.download = "otakusync-emails.csv";
  a.click();
  URL.revokeObjectURL(dlUrl);
}

async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    alert("Copied");
  }catch{
    alert("Copy failed");
  }
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

document.getElementById("pw").addEventListener("keydown", function(e){
  if(e.key === "Enter") login();
});
</script>
</body>
</html>\`;
