const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const CACHE_TTL_MS = 20 * 60 * 1000;

let _tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const r = await fetch("https://accounts.zoho.in/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID, client_secret: process.env.ZOHO_CLIENT_SECRET }),
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

  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ error: "Missing startDate or endDate" });

  const cacheKey = `bde|${startDate}|${endDate}`;
  const t0 = Date.now();

  try {
    const cached = await getCached(cacheKey);
    if (cached) { res.setHeader("X-Cache", "HIT"); return res.status(200).json(cached); }
  } catch (_) {}

  try {
    const token = await getAccessToken();
    const F_LC = "id,BDE_Name_1,Lead_Source_BDE,Lead_Type";
    const F_D  = "id,BDE_Name,Lead_Source_BDE,Lead_Type";

    const [
      genLeads, genContacts, genDeals,
      touchedLeads, touchedContacts, touchedDeals,
      connLeads, connContacts,
      qualLeads, qualContacts, qualDeals,
      discoLeads, discoContacts, discoDeals,
      presBooked, presHeld
    ] = await Promise.all([
      fetchByDateRange(token, "Leads",    F_LC, startDate, endDate, "Lead_Generated_Date"),
      fetchByDateRange(token, "Contacts", F_LC, startDate, endDate, "Lead_Generated_Date"),
      fetchByDateRange(token, "Deals",    F_D,  startDate, endDate, "Lead_Generated_Date"),
      fetchByDateRange(token, "Leads",    F_LC, startDate, endDate, "New_Lead_Worked_Date"),
      fetchByDateRange(token, "Contacts", F_LC, startDate, endDate, "New_Lead_Worked_Date"),
      fetchByDateRange(token, "Deals",    F_D,  startDate, endDate, "New_Lead_Worked_Date"),
      fetchByDateRange(token, "Leads",    F_LC, startDate, endDate, "New_Lead_Worked_Date", "(Last_Call_Outcome:equals:Connected)"),
      fetchByDateRange(token, "Contacts", F_LC, startDate, endDate, "New_Lead_Worked_Date", "(Last_Call_Outcome:equals:Connected)"),
      fetchByDateRange(token, "Leads",    F_LC, startDate, endDate, "Qualified_Lead_Date"),
      fetchByDateRange(token, "Contacts", F_LC, startDate, endDate, "Qualified_Lead_Date"),
      fetchByDateRange(token, "Deals",    F_D,  startDate, endDate, "Qualified_Lead_Date"),
      fetchByDateRange(token, "Leads",    F_LC, startDate, endDate, "Discovery_Completed_Date"),
      fetchByDateRange(token, "Contacts", F_LC, startDate, endDate, "Discovery_Completed_Date"),
      fetchByDateRange(token, "Deals",    F_D,  startDate, endDate, "Discovery_Completed_Date"),
      fetchByDateRange(token, "Deals",    F_D,  startDate, endDate, "Presentation_Booked_Date"),
      fetchByDateRange(token, "Deals",    F_D,  startDate, endDate, "Presentation_Completed_Date"),
    ]);

    // Normalize lead type
    function normalizeType(t) {
      if (!t) return "Unknown";
      const s = t.trim().toLowerCase().replace(/[\s-]+/g,"");
      if (s === "icpcold")     return "ICP Cold";
      if (s === "icphot")      return "ICP Hot";
      if (s === "icpmoderate") return "ICP Moderate";
      if (s === "icpparser")   return "ICP Parser";
      return t.trim();
    }

    // Normalize lead source into groups
    function normalizeSource(s) {
      if (!s) return "Other";
      const v = s.trim().toLowerCase();
      if (v.includes("linkedin")) return "LinkedIn";
      if (["opt nation","opt resume","career builder","indeed","monster","handshake","resume library","workable","leonar","ulinc"].includes(v)) return "Portal";
      if (v === "recruiter") return "Recruiter";
      if (v === "reference") return "Reference";
      return "Other";
    }

    // Build BDE map
    const map = {};
    function getBDE(r, isDeals) { return isDeals ? r.BDE_Name : r.BDE_Name_1; }
    function getRawSource(r) { return r.Lead_Source_BDE || ""; }
    function getRawType(r)   { return r.Lead_Type || ""; }

    function ensure(bde) {
      if (!bde) return;
      if (!map[bde]) map[bde] = {
        name: bde, generated: 0, touched: 0, connected: 0, qualified: 0, discovery: 0, presBooked: 0, presHeld: 0,
        sources: {}, sourceGroups: { LinkedIn: 0, Portal: 0, Recruiter: 0, Reference: 0, Other: 0 },
        types: { "ICP Cold": 0, "ICP Hot": 0, "ICP Moderate": 0, "ICP Parser": 0, "Unknown": 0 },
        linkedInICP: 0
      };
    }
    function inc(bde, field) { if (bde && map[bde]) map[bde][field]++; }
    function incSub(bde, field, key) {
      if (!bde || !map[bde]) return;
      map[bde][field][key] = (map[bde][field][key] || 0) + 1;
    }

    function isICP(typ) { return typ.startsWith("ICP "); }

    [...genLeads, ...genContacts].forEach(r => {
      const b = getBDE(r,false); ensure(b); inc(b,"generated");
      const src = getRawSource(r); const typ = normalizeType(getRawType(r));
      incSub(b,"sources", src||"Unknown");
      incSub(b,"sourceGroups", normalizeSource(src));
      incSub(b,"types", typ);
      if (b && map[b] && normalizeSource(src) === "LinkedIn" && isICP(typ)) map[b].linkedInICP++;
    });
    genDeals.forEach(r => {
      const b = getBDE(r,true); ensure(b); inc(b,"generated");
      const src = getRawSource(r); const typ = normalizeType(getRawType(r));
      incSub(b,"sources", src||"Unknown");
      incSub(b,"sourceGroups", normalizeSource(src));
      incSub(b,"types", typ);
      if (b && map[b] && normalizeSource(src) === "LinkedIn" && isICP(typ)) map[b].linkedInICP++;
    });
    [...touchedLeads,...touchedContacts].forEach(r => { const b=getBDE(r,false); ensure(b); inc(b,"touched"); });
    touchedDeals.forEach(r => { const b=getBDE(r,true); ensure(b); inc(b,"touched"); });
    [...connLeads,...connContacts].forEach(r => { const b=getBDE(r,false); ensure(b); inc(b,"connected"); });
    [...qualLeads,...qualContacts].forEach(r => { const b=getBDE(r,false); ensure(b); inc(b,"qualified"); });
    qualDeals.forEach(r => { const b=getBDE(r,true); ensure(b); inc(b,"qualified"); });
    [...discoLeads,...discoContacts].forEach(r => { const b=getBDE(r,false); ensure(b); inc(b,"discovery"); });
    discoDeals.forEach(r => { const b=getBDE(r,true); ensure(b); inc(b,"discovery"); });
    presBooked.forEach(r => { const b=getBDE(r,true); ensure(b); inc(b,"presBooked"); });
    presHeld.forEach(r =>   { const b=getBDE(r,true); ensure(b); inc(b,"presHeld"); });

    const bdes = Object.values(map).sort((a,b) => b.generated - a.generated);
    const result = { bdes, startDate, endDate };
    setCached(cacheKey, result).catch(() => {});
    return res.status(200).json(result);

  } catch(e) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
