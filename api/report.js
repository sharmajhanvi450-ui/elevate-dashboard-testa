export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
  const AUTH_DOMAIN   = "https://accounts.zoho.in";
  const API_DOMAIN    = "https://www.zohoapis.in";

  async function getAccessToken() {
    const r = await fetch(`${AUTH_DOMAIN}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    const data = await r.json();
    if (!data.access_token) throw new Error("Auth failed: " + JSON.stringify(data));
    return data.access_token;
  }

  async function zohoGet(token, url) {
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    return r.json();
  }

  // Fetch all records from a module with NO date filter, then filter in JS by date string match
  async function fetchModuleAll(token, module, fields) {
    let all = [], page = 1;
    while (true) {
      const url = `${API_DOMAIN}/crm/v2/${module}?fields=${fields}&per_page=200&page=${page}&sort_by=Modified_Time&sort_order=desc`;
      const data = await zohoGet(token, url);
      if (!data?.data?.length) break;
      all = all.concat(data.data);
      if (!data.info?.more_records) break;
      // Stop after 10 pages (2000 records) to avoid timeout
      if (page >= 10) break;
      page++;
    }
    return all;
  }

  // Parse Zoho date to "YYYY-MM-DD"
  // Handles: "2026-06-16T20:00:00-04:00" (ISO with tz), "2026-06-16" (date-only), "June 02, 2026" (text)
  function parseZohoDate(val) {
    if (!val) return null;
    // ISO datetime: extract the local date portion directly (before T)
    const isoMatch = val.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (isoMatch) return isoMatch[1];
    // YYYY-MM-DD already
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    // Text format "June 02, 2026" — parse on UTC to avoid day-shift
    try {
      const d = new Date(val + " UTC");
      if (isNaN(d)) return null;
      return d.toISOString().split("T")[0];
    } catch { return null; }
  }

  try {
    const { date, slot, role } = req.method === "POST" ? req.body : req.query;
    if (!date || !slot || !role) return res.status(400).json({ error: "Missing date, slot or role" });

    const token = await getAccessToken();

    // Fetch users
    const ud = await zohoGet(token, `${API_DOMAIN}/crm/v2/users?type=ActiveUsers&per_page=200`);
    const allUsers = ud?.users || [];
    const users = allUsers.filter(u => (u.role?.name || "").toLowerCase().includes(role.toLowerCase()));

    if (!users.length) {
      const roleNames = [...new Set(allUsers.map(u => u.role?.name).filter(Boolean))];
      return res.status(404).json({ error: `No users found matching "${role}".`, available_roles: roleNames });
    }

    const map = {};
    users.forEach(u => {
      map[u.id] = { name: u.full_name, id: u.id, teamLead: "", calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0, leads: 0, discoveries: 0, presentations: 0 };
    });

    // Fetch all data in parallel
    const [allCalls, allLeads, allDeals] = await Promise.all([
      fetchModuleAll(token, "Calls", "Owner,Call_Duration_in_seconds,Call_Start_Time,Call_Type,Call_Status"),
      fetchModuleAll(token, "Leads", "Owner,Qualified_Lead_Date,Discovery_Completed_Date,Team_Lead"),
      fetchModuleAll(token, "Deals", "Owner,Builder,Qualified_Lead_Date,Discovery_Completed_Date,Presentation_Booked_Date,Team_Lead"),
    ]);

    // Filter calls by date (Call_Start_Time is EST datetime like "Jun 16, 2026 05:28 PM")
    allCalls
      .filter(c => parseZohoDate(c.Call_Start_Time) === date)
      .forEach(c => {
        const id = c.Owner?.id;
        if (map[id]) {
          map[id].calls += 1;
          map[id].minutes += (parseFloat(c.Call_Duration_in_seconds || 0) / 60);
          if (c.Call_Status === "Missed") map[id].missed += 1;
          else if (c.Call_Type === "Inbound") map[id].inbound += 1;
          else map[id].outbound += 1;
        }
      });

    // Filter leads by Qualified_Lead_Date
    allLeads
      .filter(l => parseZohoDate(l.Qualified_Lead_Date) === date)
      .forEach(l => {
        const id = l.Owner?.id;
        if (map[id]) { map[id].leads += 1; if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead; }
      });

    // Filter leads by Discovery_Completed_Date
    allLeads
      .filter(l => parseZohoDate(l.Discovery_Completed_Date) === date)
      .forEach(l => {
        const id = l.Owner?.id;
        if (map[id]) { map[id].discoveries += 1; if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead; }
      });

    // Filter deals by Qualified_Lead_Date (Builder field)
    allDeals
      .filter(d => parseZohoDate(d.Qualified_Lead_Date) === date)
      .forEach(d => {
        const id = d.Builder?.id;
        if (id && map[id]) { map[id].leads += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; }
      });

    // Filter deals by Discovery_Completed_Date (Builder field)
    allDeals
      .filter(d => parseZohoDate(d.Discovery_Completed_Date) === date)
      .forEach(d => {
        const id = d.Builder?.id;
        if (id && map[id]) { map[id].discoveries += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; }
      });

    // Filter deals by Presentation_Booked_Date (Builder field)
    allDeals
      .filter(d => parseZohoDate(d.Presentation_Booked_Date) === date)
      .forEach(d => {
        const id = d.Builder?.id;
        if (id && map[id]) { map[id].presentations += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; }
      });

    const builders = Object.values(map).map(b => ({ ...b, minutes: Math.round(b.minutes) }));
    return res.status(200).json({ builders, date, slot, role });

  } catch (e) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
