const ADMIN_PASSWORD = "3ZgQgmQrqYWn";

// ── CORS HEADERS ──────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

// ── MAIN HANDLER ─────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ── PUBLIC: Email signup ─────────────────────────────────────
    if (path === "/signup" && request.method === "POST") {
      return handleSignup(request, env);
    }

    // ── PUBLIC: Feed delivery (tokenized) ────────────────────────
    if (path.startsWith("/feed/") && path.endsWith(".ics")) {
      return handleFeed(request, env, url);
    }

    // ── ADMIN ROUTES ─────────────────────────────────────────────
    if (path === "/admin" || path === "/admin/") {
      return html(ADMIN_HTML);
    }

    if (path.startsWith("/admin/api/")) {
      return handleAdminAPI(request, env, url, path);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── SIGNUP HANDLER ────────────────────────────────────────────────
async function handleSignup(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const feeds = body.feeds || ["master"];

  if (!email || !email.includes("@")) {
    return json({ error: "Valid email required" }, 400);
  }

  const now = new Date().toISOString();
  const token = crypto.randomUUID().replace(/-/g, "").substring(0, 16);

  // Store email record
  const emailRecord = {
    email,
    feeds,
    token,
    created: now,
    source: "subscribe_page",
  };

  // Key by email so we don't duplicate
  const emailKey = "email:" + email.replace(/[^a-zA-Z0-9]/g, "_");
  await env.ANIME_CAL.put(emailKey, JSON.stringify(emailRecord));

  // Also store token -> email mapping for feed delivery
  await env.ANIME_CAL.put("token:" + token, email);

  return json({ success: true, token, feeds });
}

// ── FEED HANDLER ─────────────────────────────────────────────────
async function handleFeed(request, env, url) {
  const pathParts = url.pathname.split("/");
  const filename = pathParts[pathParts.length - 1];
  const feedName = filename.replace(".ics", "");

  // Valid feeds
  const FEED_URLS = {
    master:      "https://otakusync.net/feeds/master.ics",
    crunchyroll: "https://otakusync.net/feeds/crunchyroll.ics",
    netflix:     "https://otakusync.net/feeds/netflix.ics",
    hidive:      "https://otakusync.net/feeds/hidive.ics",
    manga:       "https://otakusync.net/feeds/manga.ics",
    manhwa:      "https://otakusync.net/feeds/manhwa.ics",
    manhua:      "https://otakusync.net/feeds/manhua.ics",
  };

  // Check if this is a tokenized feed: /feed/TOKEN_FEEDNAME.ics
  // or a direct named feed: /feed/master.ics
  let targetUrl = FEED_URLS[feedName];

  if (!targetUrl) {
    // Try token format: TOKEN_feedname
    const parts = feedName.split("_");
    if (parts.length >= 2) {
      const token = parts[0];
      const feed = parts.slice(1).join("_");
      // Validate token exists
      const emailForToken = await env.ANIME_CAL.get("token:" + token);
      if (emailForToken) {
        // Log sync
        const emailKey = "email:" + emailForToken.replace(/[^a-zA-Z0-9]/g, "_");
        const record = await env.ANIME_CAL.get(emailKey);
        if (record) {
          const parsed = JSON.parse(record);
          parsed.lastSync = new Date().toISOString();
          parsed.syncCount = (parsed.syncCount || 0) + 1;
          await env.ANIME_CAL.put(emailKey, JSON.stringify(parsed));
        }
        targetUrl = FEED_URLS[feed] || FEED_URLS.master;
      }
    }
  }

  if (!targetUrl) {
    return new Response("Feed not found", { status: 404 });
  }

  // Proxy the ICS file
  const icsResponse = await fetch(targetUrl);
  const icsText = await icsResponse.text();

  return new Response(icsText, {
    headers: {
      "Content-Type": "text/calendar;charset=UTF-8",
      "Cache-Control": "max-age=3600",
    },
  });
}

// ── ADMIN API ─────────────────────────────────────────────────────
async function handleAdminAPI(request, env, url, path) {
  // Auth check
  const pw = url.searchParams.get("pw");
  if (pw !== ADMIN_PASSWORD) {
    return json({ error: "Unauthorized" }, 401);
  }

  // GET /admin/api/subscribers — original subscriber list
  if (path === "/admin/api/subscribers" && request.method === "GET") {
    const list = await env.ANIME_CAL.list({ prefix: "sub:" });
    const subs = await Promise.all(
      list.keys.map(async (k) => {
        const val = await env.ANIME_CAL.get(k.name);
        return val ? JSON.parse(val) : null;
      })
    );
    return json({ subscribers: subs.filter(Boolean) });
  }

  // POST /admin/api/subscribers — create subscriber
  if (path === "/admin/api/subscribers" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
    const token = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    const sub = {
      token,
      email: body.email || "",
      note: body.note || "",
      created: new Date().toISOString(),
      status: "active",
      lastSync: null,
      syncCount: 0,
    };
    await env.ANIME_CAL.put("sub:" + token, JSON.stringify(sub));
    const feedUrl = `https://otakusync.net/feed/${token}.ics`;
    return json({ success: true, token, feedUrl, subscriber: sub });
  }

  // PATCH /admin/api/subscribers/:token — update status
  const patchMatch = path.match(/^\/admin\/api\/subscribers\/([^/]+)$/);
  if (patchMatch && request.method === "PATCH") {
    const token = patchMatch[1];
    const existing = await env.ANIME_CAL.get("sub:" + token);
    if (!existing) return json({ error: "Not found" }, 404);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
    const updated = { ...JSON.parse(existing), ...body };
    await env.ANIME_CAL.put("sub:" + token, JSON.stringify(updated));
    return json({ success: true, subscriber: updated });
  }

  // DELETE /admin/api/subscribers/:token
  const deleteMatch = path.match(/^\/admin\/api\/subscribers\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    const token = deleteMatch[1];
    await env.ANIME_CAL.delete("sub:" + token);
    return json({ success: true });
  }

  // GET /admin/api/emails — all email signups
  if (path === "/admin/api/emails" && request.method === "GET") {
    const list = await env.ANIME_CAL.list({ prefix: "email:" });
    const emails = await Promise.all(
      list.keys.map(async (k) => {
        const val = await env.ANIME_CAL.get(k.name);
        return val ? JSON.parse(val) : null;
      })
    );
    const filtered = emails.filter(Boolean);
    return json({ emails: filtered, count: filtered.length });
  }

  // GET /admin/api/emails/export — CSV download
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
      ["Email", "Feeds", "Signed Up", "Last Sync", "Sync Count"],
      ...filtered.map((e) => [
        e.email,
        (e.feeds || []).join("|"),
        e.created || "",
        e.lastSync || "",
        e.syncCount || 0,
      ]),
    ];

    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="otakusync-emails-${new Date().toISOString().slice(0,10)}.csv"`,
        ...CORS,
      },
    });
  }

  // GET /admin/api/stats — dashboard stats
  if (path === "/admin/api/stats" && request.method === "GET") {
    const [subList, emailList] = await Promise.all([
      env.ANIME_CAL.list({ prefix: "sub:" }),
      env.ANIME_CAL.list({ prefix: "email:" }),
    ]);
    const subs = await Promise.all(subList.keys.map(async k => { const v = await env.ANIME_CAL.get(k.name); return v ? JSON.parse(v) : null; }));
    const filtered = subs.filter(Boolean);
    return json({
      totalSubscribers: filtered.length,
      activeSubscribers: filtered.filter(s => s.status === "active").length,
      totalSyncs: filtered.reduce((a, s) => a + (s.syncCount || 0), 0),
      totalEmails: emailList.keys.length,
    });
  }

  return json({ error: "Not found" }, 404);
}

// ── ADMIN HTML ────────────────────────────────────────────────────
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>OtakuSync Admin</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--red:#e84040;--gold:#f5c842;--teal:#00d4aa;--purple:#9b5de5;--dark:#04040f;--dark2:#080820;--dark3:#0d0d2b;--border:rgba(255,255,255,0.08);}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--dark);color:#f0f0f0;min-height:100vh;}
.header{background:var(--dark2);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;justify-content:space-between;align-items:center;}
.brand{font-size:20px;font-weight:700;color:#fff;letter-spacing:.05em;}
.brand span{color:var(--teal);}
#login-section{max-width:400px;margin:80px auto;background:var(--dark2);border:1px solid var(--border);border-radius:12px;padding:32px;}
#login-section h2{font-size:24px;font-weight:700;color:#fff;margin-bottom:20px;}
input[type=password],input[type=text],input[type=email]{width:100%;padding:10px 14px;background:#04040f;border:1px solid var(--border);border-radius:6px;color:#f0f0f0;font-size:14px;margin-bottom:12px;}
input:focus{outline:none;border-color:var(--teal);}
.btn{padding:10px 20px;border-radius:6px;border:none;cursor:pointer;font-size:14px;font-weight:600;transition:opacity .15s;}
.btn:hover{opacity:.85;}
.btn-primary{background:var(--red);color:#fff;}
.btn-teal{background:var(--teal);color:#04040f;}
.btn-sm{padding:6px 14px;font-size:13px;}
.btn-outline{background:transparent;color:rgba(240,240,240,.6);border:1px solid var(--border);}
.btn-outline:hover{border-color:rgba(255,255,255,.3);color:#fff;}
#main{display:none;padding:24px;}
.tabs{display:flex;gap:4px;margin-bottom:24px;border-bottom:1px solid var(--border);padding-bottom:0;}
.tab{padding:10px 20px;background:transparent;border:none;color:rgba(240,240,240,.5);cursor:pointer;font-size:14px;font-weight:600;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s;}
.tab.active{color:var(--teal);border-bottom-color:var(--teal);}
.tab-content{display:none;}
.tab-content.active{display:block;}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px;}
.stat{background:var(--dark2);border:1px solid var(--border);border-radius:10px;padding:20px;text-align:center;}
.stat-num{font-size:40px;font-weight:700;color:var(--gold);line-height:1;}
.stat-label{font-size:12px;color:rgba(240,240,240,.5);margin-top:4px;letter-spacing:.05em;}
.card{background:var(--dark2);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px;}
.card h2{font-size:16px;font-weight:700;color:#fff;margin-bottom:16px;}
.form-row{display:flex;gap:8px;flex-wrap:wrap;}
.form-row input{flex:1;min-width:180px;margin-bottom:0;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th{text-align:left;padding:8px 12px;color:rgba(240,240,240,.4);font-weight:600;letter-spacing:.05em;font-size:11px;border-bottom:1px solid var(--border);}
td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:top;}
tr:hover td{background:rgba(255,255,255,.02);}
.badge{display:inline-block;padding:3px 8px;border-radius:3px;font-size:11px;font-weight:600;}
.badge-active{background:rgba(0,212,170,.15);color:var(--teal);}
.badge-paused{background:rgba(232,64,64,.15);color:var(--red);}
.url-text{font-family:monospace;font-size:11px;color:var(--teal);word-break:break-all;}
.actions{display:flex;gap:6px;flex-wrap:wrap;}
#new-result{margin-top:12px;display:none;background:#04040f;border:1px solid rgba(0,212,170,.3);border-radius:8px;padding:14px;}
#new-result p{font-size:12px;color:rgba(240,240,240,.5);margin-bottom:6px;}
#error-box{background:rgba(232,64,64,.1);border:1px solid rgba(232,64,64,.3);border-radius:6px;padding:10px;color:var(--red);font-size:13px;display:none;margin-top:8px;}
#toast{position:fixed;bottom:20px;right:20px;background:var(--teal);color:#04040f;font-weight:700;padding:12px 20px;border-radius:8px;font-size:14px;display:none;z-index:999;}
.empty{text-align:center;padding:40px;color:rgba(240,240,240,.3);font-size:14px;}
.export-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}
.email-chip{display:inline-flex;align-items:center;gap:6px;background:rgba(155,93,229,.12);border:1px solid rgba(155,93,229,.3);border-radius:4px;padding:2px 8px;font-size:11px;color:#c4a0f0;}
</style>
</head>
<body>
<div class="header">
  <div class="brand">OTAKU<span>SYNC</span> Admin</div>
  <div id="header-status" style="font-size:13px;color:rgba(240,240,240,.4);"></div>
</div>

<div id="login-section">
  <h2>Admin Login</h2>
  <input type="password" id="pw-input" placeholder="Enter admin password" onkeydown="if(event.key==='Enter')login()"/>
  <button class="btn btn-primary" style="width:100%" onclick="login()">Login</button>
  <div id="error-box"></div>
</div>

<div id="main">
  <div class="tabs">
    <button class="tab active" onclick="showTab('dashboard',this)">Dashboard</button>
    <button class="tab" onclick="showTab('subscribers',this)">Feed Subscribers</button>
    <button class="tab" onclick="showTab('emails',this)">Email List</button>
  </div>

  <!-- DASHBOARD -->
  <div class="tab-content active" id="tab-dashboard">
    <div class="stats">
      <div class="stat"><div class="stat-num" id="stat-total">—</div><div class="stat-label">Feed Subscribers</div></div>
      <div class="stat"><div class="stat-num" id="stat-active">—</div><div class="stat-label">Active</div></div>
      <div class="stat"><div class="stat-num" id="stat-syncs">—</div><div class="stat-label">Total Syncs</div></div>
      <div class="stat"><div class="stat-num" id="stat-emails">—</div><div class="stat-label">Email Signups</div></div>
    </div>
    <div class="card">
      <h2>Quick Links</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <a href="https://otakusync.net" target="_blank" class="btn btn-outline btn-sm">🌐 Live Site</a>
        <a href="https://otakusync.net/subscribe" target="_blank" class="btn btn-outline btn-sm">📋 Subscribe Page</a>
        <a href="https://otakusync.net/feeds/master.ics" target="_blank" class="btn btn-outline btn-sm">📅 Master Feed</a>
        <a href="https://github.com/otakusyncnet/calendar-feed" target="_blank" class="btn btn-outline btn-sm">🐙 GitHub Repo</a>
      </div>
    </div>
  </div>

  <!-- FEED SUBSCRIBERS -->
  <div class="tab-content" id="tab-subscribers">
    <div class="card">
      <h2>Add New Subscriber</h2>
      <div class="form-row">
        <input type="email" id="new-email" placeholder="Email address"/>
        <input type="text" id="new-note" placeholder="Note (e.g. Gumroad order #123)"/>
        <button class="btn btn-teal" onclick="createSub()">Generate Link</button>
      </div>
      <div id="new-result">
        <p>Send this URL to your subscriber:</p>
        <div class="url-text" id="new-url"></div>
        <div style="margin-top:10px;display:flex;gap:8px;">
          <button class="btn btn-sm btn-primary" onclick="copyNewUrl()">Copy Link</button>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>All Feed Subscribers</h2>
      <table>
        <thead><tr><th>Email/Note</th><th>Created</th><th>Last Sync</th><th>Syncs</th><th>Status</th><th>Feed URL</th><th>Actions</th></tr></thead>
        <tbody id="sub-table"><tr><td colspan="7" class="empty">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- EMAIL LIST -->
  <div class="tab-content" id="tab-emails">
    <div class="card">
      <div class="export-bar">
        <h2 style="margin-bottom:0">Email Signups <span id="email-count" style="font-size:13px;color:rgba(240,240,240,.4);font-weight:400;"></span></h2>
        <button class="btn btn-teal btn-sm" onclick="exportCSV()">⬇️ Export CSV for Mailchimp</button>
      </div>
      <p style="font-size:13px;color:rgba(240,240,240,.4);margin-bottom:16px;">These are visitors who entered their email on the subscribe page. Export CSV → import to Mailchimp anytime.</p>
      <table>
        <thead><tr><th>Email</th><th>Feeds Selected</th><th>Signed Up</th><th>Last Sync</th><th>Syncs</th></tr></thead>
        <tbody id="email-table"><tr><td colspan="5" class="empty">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
var PW = "", SUBS = [], EMAILS = [];

function showError(msg){var e=document.getElementById('error-box');e.textContent=msg;e.style.display='block';}
function showToast(msg){var t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(()=>t.style.display='none',2200);}

function login(){
  PW = document.getElementById('pw-input').value;
  if(!PW){showError('Enter password');return;}
  document.getElementById('error-box').style.display='none';
  loadDashboard();
}

async function api(path, method='GET', body=null){
  var sep = path.includes('?') ? '&' : '?';
  var opts = {method, headers:{'Content-Type':'application/json'}};
  if(body) opts.body = JSON.stringify(body);
  var res = await fetch('/admin/api/' + path + sep + 'pw=' + PW, opts);
  return res.json();
}

async function loadDashboard(){
  var data = await api('stats');
  if(data.error){showError('Wrong password');return;}
  document.getElementById('login-section').style.display='none';
  document.getElementById('main').style.display='block';
  document.getElementById('header-status').textContent = 'Logged in';
  document.getElementById('stat-total').textContent = data.totalSubscribers;
  document.getElementById('stat-active').textContent = data.activeSubscribers;
  document.getElementById('stat-syncs').textContent = data.totalSyncs;
  document.getElementById('stat-emails').textContent = data.totalEmails;
  loadSubs();
  loadEmails();
}

async function loadSubs(){
  var data = await api('subscribers');
  SUBS = data.subscribers || [];
  var tbody = document.getElementById('sub-table');
  if(!SUBS.length){tbody.innerHTML='<tr><td colspan="7" class="empty">No subscribers yet</td></tr>';return;}
  tbody.innerHTML = SUBS.map(s => {
    var url = 'https://otakusync.net/feed/' + s.token + '.ics';
    var created = s.created ? new Date(s.created).toLocaleDateString() : '—';
    var lastSync = s.lastSync ? new Date(s.lastSync).toLocaleDateString() : '—';
    return \`<tr>
      <td><div style="font-weight:600">\${s.email||'—'}</div><div style="font-size:11px;color:rgba(240,240,240,.4)">\${s.note||''}</div></td>
      <td>\${created}</td><td>\${lastSync}</td><td>\${s.syncCount||0}</td>
      <td><span class="badge \${s.status==='active'?'badge-active':'badge-paused'}">\${s.status||'active'}</span></td>
      <td><div class="url-text">\${url}</div></td>
      <td><div class="actions">
        <button class="btn btn-sm btn-outline" onclick="copyUrl('\${url}')">Copy</button>
        <button class="btn btn-sm btn-outline" onclick="toggleSub('\${s.token}','\${s.status}')">\${s.status==='active'?'Pause':'Resume'}</button>
        <button class="btn btn-sm" style="background:rgba(232,64,64,.2);color:var(--red);border:1px solid rgba(232,64,64,.3)" onclick="deleteSub('\${s.token}')">Delete</button>
      </div></td>
    </tr>\`;
  }).join('');
}

async function loadEmails(){
  var data = await api('emails');
  EMAILS = data.emails || [];
  document.getElementById('email-count').textContent = '(' + EMAILS.length + ' total)';
  var tbody = document.getElementById('email-table');
  if(!EMAILS.length){tbody.innerHTML='<tr><td colspan="5" class="empty">No email signups yet — they appear here when visitors subscribe on otakusync.net/subscribe</td></tr>';return;}
  tbody.innerHTML = EMAILS.map(e => {
    var feeds = (e.feeds||['master']).map(f=>'<span class="email-chip">'+f+'</span>').join(' ');
    var created = e.created ? new Date(e.created).toLocaleDateString() : '—';
    var lastSync = e.lastSync ? new Date(e.lastSync).toLocaleDateString() : '—';
    return \`<tr>
      <td style="font-weight:600">\${e.email}</td>
      <td>\${feeds}</td>
      <td>\${created}</td>
      <td>\${lastSync}</td>
      <td>\${e.syncCount||0}</td>
    </tr>\`;
  }).join('');
}

async function createSub(){
  var email = document.getElementById('new-email').value.trim();
  var note = document.getElementById('new-note').value.trim();
  if(!email){showToast('Enter an email first');return;}
  var data = await api('subscribers','POST',{email,note});
  if(data.error){showToast('Error: '+data.error);return;}
  document.getElementById('new-url').textContent = data.feedUrl;
  document.getElementById('new-result').style.display='block';
  loadSubs();
  loadDashboard();
}

function copyNewUrl(){
  copyUrl(document.getElementById('new-url').textContent);
}

async function toggleSub(token,status){
  var newStatus = status==='active'?'paused':'active';
  await api('subscribers/'+token,'PATCH',{status:newStatus});
  loadSubs();
}

async function deleteSub(token){
  if(!confirm('Delete this subscriber?')) return;
  await api('subscribers/'+token,'DELETE');
  loadSubs();
}

function copyUrl(url){
  navigator.clipboard.writeText(url).catch(()=>{
    var t=document.createElement('textarea');t.value=url;document.body.appendChild(t);t.select();document.execCommand('copy');document.body.removeChild(t);
  });
  showToast('Copied!');
}

function exportCSV(){
  window.open('/admin/api/emails/export?pw='+PW,'_blank');
}

function showTab(id, btn){
  document.querySelectorAll('.tab-content').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el=>el.classList.remove('active'));
  document.getElementById('tab-'+id).classList.add('active');
  btn.classList.add('active');
}

document.getElementById('pw-input').addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script>
</body>
</html>`;
