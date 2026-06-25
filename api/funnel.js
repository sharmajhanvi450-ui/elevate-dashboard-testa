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

async function fetchByDateRange(token, module, fields, startDate, endDate, dateField, extraCriteria) {
  const dates = [];
  const d = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (d <= end) { dates.push(d.toISOString().split("T")[0]); d.setUTCDate(d.getUTCDate() + 1); }

  async function fetchOneDay(date) {
    let all = [], page = 1;
    while (true) {
      let criteria = `(${dateField}:equals:${date})`;
      if (extraCriteria) criteria += `AND${extraCriteria}`;
      const url = `${API_DOMAIN}/crm/v2/${module}/search?fields=${fields}&criteria=${encodeURIComponent(criteria)}&per_page=200&page=${page}`;
      const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      if (r.status === 204) break;
      const data = await r.json();
      if (!data?.data?.length) break;
      all = all.concat(data.data);
      if (!data.info?.more_records) break;
      page++;
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
    const commonFields = "id,Team_Lead";

    // Build filter criteria strings
    function lcCriteria(extra) {
      const parts = [];
      if (teamLead) parts.push(`(Team_Lead:equals:${teamLead})`);
      if (source)   parts.push(`(Lead_Source_BDE_:equals:${source})`);
      if (bde)      parts.push(`(BDE__Name_:equals:${bde})`);
      if (extra)    parts.push(`(${extra})`);
      return parts.length ? parts.join("AND") : null;
    }
    function dCriteria(extra) {
      const parts = [];
      if (teamLead) parts.push(`(Team_Lead:equals:${teamLead})`);
      if (source)   parts.push(`(Lead_Source_BDE_:equals:${source})`);
      if (bde)      parts.push(`(BDE_Name:equals:${bde})`);
      if (extra)    parts.push(`(${extra})`);
      return parts.length ? parts.join("AND") : null;
    }

    const [
      assignedLeads, assignedContacts, assignedDeals,
      touchedLeads,  touchedContacts,  touchedDeals,
      connectedLeads, connectedContacts,
      qualLeads,  qualContacts,  qualDeals,
      discoLeads, discoContacts, discoDeals,
      presBooked, presHeld, closedDeals
    ] = await Promise.all([
      fetchByDateRange(token, "Leads",    commonFields, startDate, endDate, "Lead_Assigned_Date",        lcCriteria()),
      fetchByDateRange(token, "Contacts", commonFields, startDate, endDate, "Lead_Assigned_Date",        lcCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Lead_Assigned_Date",        dCriteria()),
      fetchByDateRange(token, "Leads",    commonFields, startDate, endDate, "New_Lead_Worked_Date",      lcCriteria()),
      fetchByDateRange(token, "Contacts", commonFields, startDate, endDate, "New_Lead_Worked_Date",      lcCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "New_Lead_Worked_Date",      dCriteria()),
      fetchByDateRange(token, "Leads",    commonFields, startDate, endDate, "New_Lead_Worked_Date",      lcCriteria("Last_Call_Outcome:equals:Connected")),
      fetchByDateRange(token, "Contacts", commonFields, startDate, endDate, "New_Lead_Worked_Date",      lcCriteria("Last_Call_Outcome:equals:Connected")),
      fetchByDateRange(token, "Leads",    commonFields, startDate, endDate, "Qualified_Lead_Date",       lcCriteria()),
      fetchByDateRange(token, "Contacts", commonFields, startDate, endDate, "Qualified_Lead_Date",       lcCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Qualified_Lead_Date",       dCriteria()),
      fetchByDateRange(token, "Leads",    commonFields, startDate, endDate, "Discovery_Completed_Date",  lcCriteria()),
      fetchByDateRange(token, "Contacts", commonFields, startDate, endDate, "Discovery_Completed_Date",  lcCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Discovery_Completed_Date",  dCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Presentation_Booked_Date",  dCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Presentation_Completed_Date", dCriteria()),
      fetchByDateRange(token, "Deals",    commonFields, startDate, endDate, "Deal_Closed_Date",          dCriteria("Stage:equals:Closed Won")),
    ]);

    const funnel = [
      { stage: "Leads Assigned",  count: assignedLeads.length  + assignedContacts.length  + assignedDeals.length,  icon: "👥" },
      { stage: "Data Touched",    count: touchedLeads.length   + touchedContacts.length   + touchedDeals.length,   icon: "✋" },
      { stage: "Calls Connected", count: connectedLeads.length + connectedContacts.length,                          icon: "📞" },
      { stage: "Qualified Leads", count: qualLeads.length      + qualContacts.length      + qualDeals.length,       icon: "⭐" },
      { stage: "Discovery Done",  count: discoLeads.length     + discoContacts.length     + discoDeals.length,      icon: "🔍" },
      { stage: "Pres. Booked",    count: presBooked.length,                                                          icon: "📅" },
      { stage: "Pres. Held",      count: presHeld.length,                                                            icon: "🎯" },
      { stage: "Closed Won",      count: closedDeals.length,                                                          icon: "🏆" },
    ];

    // BDE list from Zoho users
    let bdes = [];
    try {
      const ud = await fetch(`${API_DOMAIN}/crm/v2/users?type=ActiveUsers&per_page=200`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      const udata = await ud.json();
      bdes = (udata?.users || []).filter(u => (u.role?.name || "").toLowerCase().includes("builder")).map(u => u.full_name).sort();
    } catch (_) {}

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
