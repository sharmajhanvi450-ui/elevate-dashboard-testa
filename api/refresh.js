export const config = { maxDuration: 60 };

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const CRON_SECRET   = process.env.CRON_SECRET || "elevate2024";

const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const AUTH_DOMAIN   = "https://accounts.zoho.in";
const API_DOMAIN    = "https://www.zohoapis.in";

function getTodayEST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function anyoneActiveRecently() {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_activity?created_at=gte.${since}&limit=1&select=id`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function logAPI(type, role, date_range, triggered_by, duration_ms) {
  fetch(`${SUPABASE_URL}/rest/v1/api_logs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type, role, date_range, triggered_by, duration_ms })
  }).catch(() => {});
}

async function setCached(key, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/report_cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({ cache_key: key, data, created_at: new Date().toISOString() })
  });
}

// In-memory token cache — reuse for 50 min to avoid Zoho rate limits
let _tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const r = await fetch(`${AUTH_DOMAIN}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("Auth failed: " + JSON.stringify(data));
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return data.access_token;
}

async function zohoGet(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (r.status === 204) return {};
  return r.json();
}

// ── Concurrency limiter + retry, so we don't overrun Zoho's rate limit and
//    never silently drop data on a 429/5xx (same pattern as funnel.js/bde.js). ──
function makeLimiter(max) {
  let active = 0; const q = [];
  const pump = () => { while (active < max && q.length) { active++; (q.shift())(); } };
  return fn => new Promise((resolve, reject) => {
    q.push(() => fn().then(resolve, reject).finally(() => { active--; pump(); }));
    pump();
  });
}
const _limit = makeLimiter(8);
async function zohoFetch(url, opts) {
  return _limit(async () => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, opts);
      if ((r.status === 429 || r.status >= 500) && attempt < 6) {
        await new Promise(res => setTimeout(res, Math.min(800 * 2 ** attempt, 12000) + Math.floor(Math.random() * 300)));
        continue;
      }
      return r;
    }
  });
}

// COQL reads LIVE data (not the eventually-consistent /search index used
// previously), matching the same migration already done in funnel.js/bde.js
// and report.js.
async function fetchByDateRange(token, module, select, startDate, endDate, dateField) {
  const dates = [];
  const d = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (d <= end) { dates.push(d.toISOString().split("T")[0]); d.setUTCDate(d.getUTCDate() + 1); }

  async function fetchOneDay(date) {
    let all = [], offset = 0;
    while (true) {
      const q = `select ${select} from ${module} where ${dateField} = '${date}' limit ${offset}, 200`;
      const r = await zohoFetch(`${API_DOMAIN}/crm/v2/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ select_query: q }),
      });
      if (r.status === 204) break;
      const data = await r.json();
      if (!data?.data?.length) break;
      all = all.concat(data.data);
      if (!data.info?.more_records) break;
      offset += 200;
      if (offset >= 2000) break;
    }
    return all;
  }

  let all = [];
  const BATCH = 6;
  for (let i = 0; i < dates.length; i += BATCH) {
    const results = await Promise.all(dates.slice(i, i + BATCH).map(fetchOneDay));
    results.forEach(r => { all = all.concat(r); });
  }
  return all;
}

// Calls uses a datetime field, so it needs a `between` window rather than the
// date-only equality above — same two-half-day-IST-window approach as
// report.js/snapshot.js.
async function coqlCallsWindow(token, startDT, endDT) {
  const out = [];
  let offset = 0;
  while (true) {
    const q = `select Owner, Call_Duration_in_seconds, Call_Start_Time, Call_Type, Call_Status `
            + `from Calls where Call_Start_Time between '${startDT}' and '${endDT}' limit ${offset}, 200`;
    const r = await zohoFetch(`${API_DOMAIN}/crm/v2/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ select_query: q }),
    });
    if (r.status === 204) break;
    const data = await r.json();
    if (!data?.data?.length) break;
    out.push(...data.data);
    if (!data.info?.more_records) break;
    offset += 200;
    if (offset >= 2000) break;
  }
  return out;
}
// Instant of 00:00:00 America/New_York on `dateStr`, as a UTC Date — DST-safe.
// The business runs on US Eastern hours, not IST — a fixed IST offset here was
// pulling in calls from the wrong 9.5-hour-shifted window and overcounting
// (confirmed against Zoho's own UI count).
function nyMidnightUTC(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const noonGuessUTC = new Date(Date.UTC(y, m - 1, d, 16, 0, 0)); // ~noon ET regardless of DST
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = dtf.formatToParts(noonGuessUTC).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const offsetMin = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - noonGuessUTC.getTime()) / 60000;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60000);
}
const fmtCOQL = d => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");

async function fetchCallsForRange(token, date) {
  const dayStart = nyMidnightUTC(date);
  const dayMid   = new Date(dayStart.getTime() + 12 * 60 * 60 * 1000);
  const dayEnd   = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1000);
  const windows = [
    [fmtCOQL(dayStart), fmtCOQL(new Date(dayMid.getTime() - 1000))],
    [fmtCOQL(dayMid), fmtCOQL(dayEnd)],
  ];
  const parts = await Promise.all(windows.map(([s, e]) => coqlCallsWindow(token, s, e)));
  return parts.flat();
}

async function refreshRole(token, allUsers, role, date) {
  const cacheKey = `${role}|${date}|${date}`;
  const isCloser   = role.toLowerCase().includes("closer");
  const isTeamLead = role.toLowerCase().includes("team leader");

  if (isTeamLead) {
    function getTLName(roleName) {
      if (roleName.includes("Soham"))   return "Soham";
      if (roleName.includes("Tejasvi")) return "Tejasvi";
      if (roleName.includes("Mamta"))   return "Mamta Das";
      return null;
    }
    const tlMembers = allUsers.filter(u => {
      const r = u.role?.name || "";
      return getTLName(r) && (r.includes("Builder") || r.includes("Closer"));
    });
    const builderMap = {}, closerMap = {};
    tlMembers.forEach(u => {
      const tl = getTLName(u.role.name);
      const isC = u.role.name.includes("Closer");
      const base = { name: u.full_name, id: u.id, tlName: tl, calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0 };
      if (isC) closerMap[u.id] = { ...base, presentations: 0, dealsClosed: 0, newUpfront: 0, futureUpfront: 0 };
      else     builderMap[u.id] = { ...base, leads: 0, discoveries: 0, presBooked: 0, presCompleted: 0 };
    });
    const [calls, presHeld, closedDeals, upfrontDeals,
           leadsQL, leadsDisc, dealsQL, dealsDisc, dealsPB, dealsPC] = await Promise.all([
      fetchCallsForRange(token, date),
      fetchByDateRange(token, "Deals", "Owner, Team_Lead",                       date, date, "Presentation_Completed_Date"),
      fetchByDateRange(token, "Deals", "Owner, Future_Booked_Upfront, Team_Lead", date, date, "Deal_Closed_Date"),
      fetchByDateRange(token, "Deals", "Owner, Upfront_Amount, Team_Lead",        date, date, "Upfront_Amount_Received_Date"),
      fetchByDateRange(token, "Leads", "Owner, Team_Lead",                       date, date, "Qualified_Lead_Date"),
      fetchByDateRange(token, "Leads", "Owner, Team_Lead",                       date, date, "Discovery_Completed_Date"),
      fetchByDateRange(token, "Deals", "Owner, Builder, Team_Lead",               date, date, "Qualified_Lead_Date"),
      fetchByDateRange(token, "Deals", "Owner, Builder, Team_Lead",               date, date, "Discovery_Completed_Date"),
      fetchByDateRange(token, "Deals", "Owner, Builder, Team_Lead",               date, date, "Presentation_Booked_Date"),
      fetchByDateRange(token, "Deals", "Owner, Builder, Team_Lead",               date, date, "Presentation_Completed_Date"),
    ]);
    calls.forEach(c => {
      const id = c.Owner?.id;
      const mins = parseFloat(c.Call_Duration_in_seconds || 0) / 60;
      const map = builderMap[id] ? builderMap : closerMap[id] ? closerMap : null;
      if (!map) return;
      map[id].minutes += mins;
      if (c.Call_Status === "Missed") { map[id].missed += 1; }
      else if (c.Call_Type === "Inbound") { map[id].inbound += 1; }
      else { map[id].calls += 1; map[id].outbound += 1; }
    });
    leadsQL.forEach(l  => { const id=l.Owner?.id;   if(builderMap[id]) builderMap[id].leads++; });
    leadsDisc.forEach(l => { const id=l.Owner?.id;   if(builderMap[id]) builderMap[id].discoveries++; });
    dealsQL.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].leads++; });
    dealsDisc.forEach(d => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].discoveries++; });
    dealsPB.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].presBooked++; });
    dealsPC.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].presCompleted++; });
    presHeld.forEach(d    => { const id=d.Owner?.id; if(closerMap[id]) closerMap[id].presentations++; });
    closedDeals.forEach(d => { const id=d.Owner?.id; if(closerMap[id]) closerMap[id].futureUpfront += parseFloat(d.Future_Booked_Upfront||0); });
    upfrontDeals.forEach(d=> { const id=d.Owner?.id; if(closerMap[id]) { closerMap[id].dealsClosed++; closerMap[id].newUpfront += parseFloat(d.Upfront_Amount||0); } });
    const teams = {};
    ["Soham","Tejasvi","Mamta Das"].forEach(tl => {
      teams[tl] = {
        builders: Object.values(builderMap).filter(b=>b.tlName===tl).map(b=>({...b,minutes:Math.round(b.minutes)})),
        closers:  Object.values(closerMap).filter(c=>c.tlName===tl).map(c=>({...c,minutes:Math.round(c.minutes),newUpfront:Math.round(c.newUpfront),futureUpfront:Math.round(c.futureUpfront),revenue:Math.round(c.newUpfront+c.futureUpfront)})),
      };
    });
    await setCached(cacheKey, { teams, startDate: date, endDate: date, slot: "day", role });
    return;
  }

  const users = allUsers.filter(u => (u.role?.name || "").toLowerCase().includes(role.toLowerCase()));

  if (isCloser) {
    const map = {};
    users.forEach(u => { map[u.id] = { name: u.full_name, id: u.id, teamLead: "", calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0, presentations: 0, dealsClosed: 0, newUpfront: 0, futureUpfront: 0 }; });
    const [calls, presHeld, closedDeals, upfrontDeals] = await Promise.all([
      fetchCallsForRange(token, date),
      fetchByDateRange(token, "Deals", "Owner, Team_Lead", date, date, "Presentation_Completed_Date"),
      fetchByDateRange(token, "Deals", "Owner, Future_Booked_Upfront, Team_Lead", date, date, "Deal_Closed_Date"),
      fetchByDateRange(token, "Deals", "Owner, Upfront_Amount, Team_Lead", date, date, "Upfront_Amount_Received_Date"),
    ]);
    calls.forEach(c => {
      const id = c.Owner?.id; if (!map[id]) return;
      map[id].minutes += (parseFloat(c.Call_Duration_in_seconds||0)/60);
      if (c.Call_Status==="Missed") { map[id].missed++; return; }
      if (c.Call_Type==="Inbound")  { map[id].inbound++; return; }
      map[id].calls++; map[id].outbound++;
    });
    presHeld.forEach(d    => { const id=d.Owner?.id; if(!map[id]) return; map[id].presentations++; if(!map[id].teamLead&&d.Team_Lead) map[id].teamLead=d.Team_Lead; });
    closedDeals.forEach(d => { const id=d.Owner?.id; if(!map[id]) return; map[id].futureUpfront+=parseFloat(d.Future_Booked_Upfront||0); if(!map[id].teamLead&&d.Team_Lead) map[id].teamLead=d.Team_Lead; });
    upfrontDeals.forEach(d=> { const id=d.Owner?.id; if(!map[id]) return; map[id].dealsClosed++; map[id].newUpfront+=parseFloat(d.Upfront_Amount||0); if(!map[id].teamLead&&d.Team_Lead) map[id].teamLead=d.Team_Lead; });
    const closers = Object.values(map).map(b=>({...b,minutes:Math.round(b.minutes),newUpfront:Math.round(b.newUpfront),futureUpfront:Math.round(b.futureUpfront),revenue:Math.round(b.newUpfront+b.futureUpfront)}));
    await setCached(cacheKey, { closers, startDate: date, endDate: date, slot: "day", role });
    return;
  }

  // Builder
  const map = {};
  users.forEach(u => { map[u.id] = { name: u.full_name, id: u.id, teamLead: "", calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0, leads: 0, discoveries: 0, presBooked: 0, presCompleted: 0 }; });
  const [calls, leadsQL, leadsDisc, dealsQL, dealsDisc, dealsPB, dealsPC] = await Promise.all([
    fetchCallsForRange(token, date),
    fetchByDateRange(token, "Leads", "Owner, Team_Lead", date, date, "Qualified_Lead_Date"),
    fetchByDateRange(token, "Leads", "Owner, Team_Lead", date, date, "Discovery_Completed_Date"),
    fetchByDateRange(token, "Deals", "Owner, Builder, Team_Lead", date, date, "Qualified_Lead_Date"),
    fetchByDateRange(token, "Deals", "Owner, Builder, Team_Lead", date, date, "Discovery_Completed_Date"),
    fetchByDateRange(token, "Deals", "Owner, Builder, Team_Lead", date, date, "Presentation_Booked_Date"),
    fetchByDateRange(token, "Deals", "Owner, Builder, Team_Lead", date, date, "Presentation_Completed_Date"),
  ]);
  calls.forEach(c => {
    const id = c.Owner?.id; if (!map[id]) return;
    map[id].minutes += (parseFloat(c.Call_Duration_in_seconds||0)/60);
    if (c.Call_Status==="Missed") { map[id].missed++; return; }
    if (c.Call_Type==="Inbound")  { map[id].inbound++; return; }
    map[id].calls++; map[id].outbound++;
  });
  leadsQL.forEach(l  => { const id=l.Owner?.id; if(!map[id]) return; map[id].leads++;        if(!map[id].teamLead&&l.Team_Lead) map[id].teamLead=l.Team_Lead; });
  leadsDisc.forEach(l => { const id=l.Owner?.id; if(!map[id]) return; map[id].discoveries++;  if(!map[id].teamLead&&l.Team_Lead) map[id].teamLead=l.Team_Lead; });
  dealsQL.forEach(d   => { const id=d.Builder?.id; if(!id||!map[id]) return; map[id].leads++;        if(!map[id].teamLead&&d.Team_Lead) map[id].teamLead=d.Team_Lead; });
  dealsDisc.forEach(d => { const id=d.Builder?.id; if(!id||!map[id]) return; map[id].discoveries++;  if(!map[id].teamLead&&d.Team_Lead) map[id].teamLead=d.Team_Lead; });
  dealsPB.forEach(d   => { const id=d.Builder?.id; if(!id||!map[id]) return; map[id].presBooked++;    if(!map[id].teamLead&&d.Team_Lead) map[id].teamLead=d.Team_Lead; });
  dealsPC.forEach(d   => { const id=d.Builder?.id; if(!id||!map[id]) return; map[id].presCompleted++; if(!map[id].teamLead&&d.Team_Lead) map[id].teamLead=d.Team_Lead; });
  const builders = Object.values(map).map(b=>({...b,minutes:Math.round(b.minutes)}));
  await setCached(cacheKey, { builders, startDate: date, endDate: date, slot: "day", role });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Verify cron secret
  const secret = req.headers["x-cron-secret"] || req.query.secret;
  if (secret !== CRON_SECRET) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Check if anyone was active in last 30 min (skip check if force=true)
    const force = req.query.force === "true";
    if (!force) {
      const active = await anyoneActiveRecently();
      if (!active) {
        logAPI("cron_skip", null, null, "cron", 0);
        return res.status(200).json({ skipped: true, reason: "No active users in last 30 min" });
      }
    }

    const date  = getTodayEST();
    const t0    = Date.now();
    const token = await getAccessToken();
    const ud    = await zohoGet(token, `${API_DOMAIN}/crm/v2/users?type=ActiveUsers&per_page=200`);
    const allUsers = ud?.users || [];

    // Refresh all 3 roles in parallel
    await Promise.all([
      refreshRole(token, allUsers, "Builder",     date),
      refreshRole(token, allUsers, "Closer",      date),
      refreshRole(token, allUsers, "Team Leader", date),
    ]);

    logAPI("cron_run", "all", date, "cron", Date.now() - t0);
    return res.status(200).json({ ok: true, date, refreshed: ["Builder", "Closer", "Team Leader"] });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
