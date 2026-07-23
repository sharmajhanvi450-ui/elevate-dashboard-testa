export const config = { maxDuration: 60 };
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const CACHE_TTL_MS = 20 * 60 * 1000;

let _tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const r = await fetch("https://accounts.zoho.in/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("Auth failed: " + JSON.stringify(data));
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return data.access_token;
}

async function getCached(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/report_cache?cache_key=eq.${encodeURIComponent(key)}&select=data,created_at`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  const rows = await r.json();
  if (!rows?.length) return null;
  if (Date.now() - new Date(rows[0].created_at).getTime() > CACHE_TTL_MS) return null;
  return rows[0].data;
}

async function setCached(key, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  fetch(`${SUPABASE_URL}/rest/v1/report_cache`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ cache_key: key, data, created_at: new Date().toISOString() })
  }).catch(() => {});
}

function logAPI(type, role, date_range, triggered_by, duration_ms) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  fetch(`${SUPABASE_URL}/rest/v1/api_logs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type, role, date_range, triggered_by, duration_ms })
  }).catch(() => {});
}

const API_DOMAIN = "https://www.zohoapis.in";

// ── Concurrency limiter + retry, so we don't overrun Zoho's rate limit and
//    never silently drop data on a 429/5xx (which caused undercounts). ─────────
function makeLimiter(max) {
  let active = 0; const q = [];
  const pump = () => { while (active < max && q.length) { active++; (q.shift())(); } };
  return fn => new Promise((resolve, reject) => {
    q.push(() => fn().then(resolve, reject).finally(() => { active--; pump(); }));
    pump();
  });
}
const _limit = makeLimiter(8);           // max 8 concurrent Zoho requests
let _stats = { requests: 0, retries: 0, failed: 0 };
async function zohoFetch(url, opts) {
  return _limit(async () => {
    for (let attempt = 0; ; attempt++) {
      _stats.requests++;
      const r = await fetch(url, opts);
      if ((r.status === 429 || r.status >= 500) && attempt < 6) {
        _stats.retries++;
        await new Promise(res => setTimeout(res, Math.min(800 * 2 ** attempt, 12000) + Math.floor(Math.random() * 300)));
        continue;
      }
      if (r.status === 429 || r.status >= 500) _stats.failed++;
      return r;
    }
  });
}

// COQL reads LIVE data (not the eventually-consistent /search index), so counts
// are exact and identical across tokens. Fetched per-day to stay under COQL's
// 2000-record-per-query ceiling. `select` is a COQL field list; `extraWhere` is
// an optional COQL WHERE fragment.
async function fetchByDateRange(token, module, select, startDate, endDate, dateField, extraWhere) {
  const dates = [];
  const d = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (d <= end) { dates.push(d.toISOString().split("T")[0]); d.setUTCDate(d.getUTCDate() + 1); }

  async function fetchOneDay(date) {
    let all = [], offset = 0;
    while (true) {
      let where = `${dateField} = '${date}'`;
      if (extraWhere) where += ` and ${extraWhere}`;
      const q = `select ${select} from ${module} where ${where} limit ${offset}, 200`;
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
      if (offset >= 2000) break;   // COQL ceiling; daily volume stays well under this
    }
    return all;
  }

  let all = [];
  const BATCH = 5;
  for (let i = 0; i < dates.length; i += BATCH) {
    const results = await Promise.all(dates.slice(i, i + BATCH).map(fetchOneDay));
    results.forEach(r => { all = all.concat(r); });
  }
  return all;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { startDate, endDate, bde = "", teamLead = "", source = "" } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ error: "Missing startDate or endDate" });

  const cacheKey = `funnel|${startDate}|${endDate}|${bde}|${teamLead}|${source}`;
  const t0 = Date.now();

  try {
    const cached = await getCached(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      logAPI("cache_hit", "funnel", `${startDate} to ${endDate}`, "user", Date.now() - t0);
      return res.status(200).json(cached);
    }
  } catch (_) {}

  try {
    const token = await getAccessToken();
    _stats = { requests: 0, retries: 0, failed: 0 };

    const commonFields = "id, Owner, Lead_Generated_Date";   // COQL select list

    // Exclude records owned by these generic accounts. COQL returns Owner as
    // {id} only (no email), so resolve their user IDs and filter by id.
    const EXCLUDE_EMAILS = new Set(["bdteamleaders@elevateme.pro", "bde@elevateme.pro", "admissions@elevateme.pro"]);
    const usersResp = await zohoFetch(`${API_DOMAIN}/crm/v2/users?type=AllUsers&per_page=200`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const usersJson = await usersResp.json().catch(() => ({}));
    const excludedIds = new Set((usersJson.users || []).filter(u => EXCLUDE_EMAILS.has((u.email || "").toLowerCase())).map(u => u.id));
    const keep = arr => arr.filter(r => !excludedIds.has(r.Owner?.id));

    // Build COQL WHERE fragments from the optional filters
    const esc = v => String(v).replace(/'/g, "\\'");
    function lcCriteria(extra) {
      const parts = [];
      if (teamLead) parts.push(`Team_Lead = '${esc(teamLead)}'`);
      if (source)   parts.push(`Lead_Source_BDE = '${esc(source)}'`);
      if (bde)      parts.push(`BDE_Name_1 = '${esc(bde)}'`);
      if (extra)    parts.push(extra);
      return parts.length ? parts.join(" and ") : null;
    }
    function dCriteria(extra) {
      const parts = [];
      if (teamLead) parts.push(`Team_Lead = '${esc(teamLead)}'`);
      if (source)   parts.push(`Lead_Source_BDE = '${esc(source)}'`);
      if (bde)      parts.push(`BDE_Name1 = '${esc(bde)}'`);
      if (extra)    parts.push(extra);
      return parts.length ? parts.join(" and ") : null;
    }

    const [
      assignedLeads, assignedContacts, assignedDeals,
      touchedLeads,  touchedContacts,  touchedDeals,
      connectedLeads, connectedContacts, connectedDeals,
      qualLeads,  qualContacts,  qualDeals,
      discoLeads, discoContacts, discoDeals,
      presBooked, presHeld, closedDeals
    ] = (await Promise.all([
      fetchByDateRange(token, "Leads",    commonFields, startDate, endDate, "Lead_Assigned_Date",        lcCriteria()),
      fetchByDateRange(token, "Contacts", commonFields, startDate, endDate, "Lead_Assigned_Date",        lcCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Lead_Assigned_Date",        dCriteria()),
      fetchByDateRange(token, "Leads",    commonFields, startDate, endDate, "New_Lead_Worked_Date",      lcCriteria()),
      fetchByDateRange(token, "Contacts", commonFields, startDate, endDate, "New_Lead_Worked_Date",      lcCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "New_Lead_Worked_Date",      dCriteria()),
      fetchByDateRange(token, "Leads",    commonFields, startDate, endDate, "New_Lead_Worked_Date",      lcCriteria("Connectivity = 'Connected'")),
      fetchByDateRange(token, "Contacts", commonFields, startDate, endDate, "New_Lead_Worked_Date",      lcCriteria("Connectivity = 'Connected'")),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "New_Lead_Worked_Date",      dCriteria("Connectivity = 'Connected'")),
      fetchByDateRange(token, "Leads",    commonFields, startDate, endDate, "Qualified_Lead_Date",       lcCriteria()),
      fetchByDateRange(token, "Contacts", commonFields, startDate, endDate, "Qualified_Lead_Date",       lcCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Qualified_Lead_Date",       dCriteria()),
      fetchByDateRange(token, "Leads",    commonFields, startDate, endDate, "Discovery_Completed_Date",  lcCriteria()),
      fetchByDateRange(token, "Contacts", commonFields, startDate, endDate, "Discovery_Completed_Date",  lcCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Discovery_Completed_Date",  dCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Presentation_Booked_Date",  dCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Presentation_Completed_Date", dCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Deal_Closed_Date",          dCriteria("Stage = 'Closed Won'")),
    ])).map(keep);

    // Split each stage by lead-generation cohort: "current" = lead generated
    // within the selected period (Lead_Generated_Date >= startDate), else "old".
    const genDate = r => { const v = r.Lead_Generated_Date; if (!v) return null; const m = String(v).match(/^\d{4}-\d{2}-\d{2}/); return m ? m[0] : null; };
    const isCur = r => { const g = genDate(r); return !!(g && g >= startDate); };
    const split = (...arrs) => { let current = 0, old = 0; arrs.forEach(a => a.forEach(r => isCur(r) ? current++ : old++)); return { current, old, count: current + old }; };

    const funnel = [
      { stage: "Leads Assigned",  ...split(assignedLeads, assignedContacts, assignedDeals),  icon: "👥" },
      { stage: "Data Touched",    ...split(touchedLeads, touchedContacts, touchedDeals),     icon: "✋" },
      { stage: "Calls Connected", ...split(connectedLeads, connectedContacts, connectedDeals), icon: "📞" },
      { stage: "Qualified Leads", ...split(qualLeads, qualContacts, qualDeals),              icon: "⭐" },
      { stage: "Discovery Done",  ...split(discoLeads, discoContacts, discoDeals),           icon: "🔍" },
      { stage: "Pres. Booked",    ...split(presBooked),                                       icon: "📅" },
      { stage: "Pres. Held",      ...split(presHeld),                                         icon: "🎯" },
      { stage: "Closed Won",      ...split(closedDeals),                                       icon: "🏆" },
    ];

    // BDE list — hardcoded from CRM data (BDE Name field in Leads module)
    const bdes = [
      "Sunil Patel", "Ajay Darbar", "Prem Thakar", "Ronak Khant",
      "Jiya Chandrawanshi", "Dhanraj Solanki", "Bhoomi Barot", "Kinjal Menaria",
      "Shruti Mori", "Heer Nakum", "Meet Patel", "Shreya Lathiya",
      "Supratim Dutta", "Soumya Singh", "Varun Singh", "Ved Sutariya"
    ].sort();

    const result = {
      funnel, bdes,
      teamLeads: ["Tejasvi Pathe", "Soham Bajpai", "Mamta Das", "Yash Karwa"],
      sources: ["LinkedIn", "OPT Nation", "Recruiter", "Career Builder", "OPT Resume", "Indeed", "LinkedIn Chat", "Reference"],
      startDate, endDate
    };

    setCached(cacheKey, result);
    logAPI("zoho_call", "funnel", `${startDate} to ${endDate}`, "user", Date.now() - t0);
    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
