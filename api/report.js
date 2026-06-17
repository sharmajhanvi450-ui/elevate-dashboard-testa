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

  // Parse Zoho date to "YYYY-MM-DD"
  function parseZohoDate(val) {
    if (!val) return null;
    const isoMatch = val.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (isoMatch) return isoMatch[1];
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    try {
      const d = new Date(val + " UTC");
      if (isNaN(d)) return null;
      return d.toISOString().split("T")[0];
    } catch { return null; }
  }

  // Fetch calls for a specific date by sorting by Call_Start_Time DESC
  // and stopping as soon as the page goes past the target date.
  async function fetchCallsForDate(token, date, fields) {
    let all = [], page = 1;
    while (page <= 50) {
      const url = `${API_DOMAIN}/crm/v2/Calls?fields=${fields}&per_page=200&page=${page}&sort_by=Call_Start_Time&sort_order=desc`;
      const data = await zohoGet(token, url);
      if (!data?.data?.length) break;

      for (const record of data.data) {
        if (parseZohoDate(record.Call_Start_Time) === date) all.push(record);
      }

      // Stop once the oldest record on this page is before the target date
      const oldestDate = parseZohoDate(data.data.at(-1)?.Call_Start_Time);
      if (oldestDate && oldestDate < date) break;
      if (!data.info?.more_records) break;
      page++;
    }
    return all;
  }

  // Fetch records filtered by a date criteria — used for Leads and Deals
  // where Zoho supports (field:equals:YYYY-MM-DD) on plain date fields.
  async function fetchByCriteria(token, module, fields, criteria) {
    let all = [], page = 1;
    while (true) {
      const url = `${API_DOMAIN}/crm/v2/${module}?fields=${fields}&criteria=${encodeURIComponent(criteria)}&per_page=200&page=${page}`;
      const data = await zohoGet(token, url);
      if (!data?.data?.length) break;
      all = all.concat(data.data);
      if (!data.info?.more_records) break;
      page++;
    }
    return all;
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
      map[u.id] = { name: u.full_name, id: u.id, teamLead: "", calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0, leads: 0, discoveries: 0, presBooked: 0, presCompleted: 0 };
    });

    // Fetch all data in parallel using targeted queries
    const [
      calls,
      leadsQL, leadsDisc,
      dealsQL, dealsDisc, dealsPB, dealsPC,
    ] = await Promise.all([
      fetchCallsForDate(token, date, "Owner,Call_Duration_in_seconds,Call_Start_Time,Call_Type,Call_Status"),
      fetchByCriteria(token, "Leads", "Owner,Team_Lead", `(Qualified_Lead_Date:equals:${date})`),
      fetchByCriteria(token, "Leads", "Owner,Team_Lead", `(Discovery_Completed_Date:equals:${date})`),
      fetchByCriteria(token, "Deals", "Owner,Builder,Team_Lead", `(Qualified_Lead_Date:equals:${date})`),
      fetchByCriteria(token, "Deals", "Owner,Builder,Team_Lead", `(Discovery_Completed_Date:equals:${date})`),
      fetchByCriteria(token, "Deals", "Owner,Builder,Team_Lead", `(Presentation_Booked_Date:equals:${date})`),
      fetchByCriteria(token, "Deals", "Owner,Builder,Team_Lead", `(Presentation_Completed_Date:equals:${date})`),
    ]);

    // Aggregate calls
    calls.forEach(c => {
      const id = c.Owner?.id;
      if (!map[id]) return;
      map[id].calls += 1;
      map[id].minutes += (parseFloat(c.Call_Duration_in_seconds || 0) / 60);
      if (c.Call_Status === "Missed") map[id].missed += 1;
      else if (c.Call_Type === "Inbound") map[id].inbound += 1;
      else map[id].outbound += 1;
    });

    // Aggregate leads — Qualified_Lead_Date (Owner)
    leadsQL.forEach(l => {
      const id = l.Owner?.id;
      if (!map[id]) return;
      map[id].leads += 1;
      if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead;
    });

    // Aggregate leads — Discovery_Completed_Date (Owner)
    leadsDisc.forEach(l => {
      const id = l.Owner?.id;
      if (!map[id]) return;
      map[id].discoveries += 1;
      if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead;
    });

    // Aggregate deals — Qualified_Lead_Date (Builder)
    dealsQL.forEach(d => {
      const id = d.Builder?.id;
      if (!id || !map[id]) return;
      map[id].leads += 1;
      if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
    });

    // Aggregate deals — Discovery_Completed_Date (Builder)
    dealsDisc.forEach(d => {
      const id = d.Builder?.id;
      if (!id || !map[id]) return;
      map[id].discoveries += 1;
      if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
    });

    // Aggregate deals — Presentation_Booked_Date (Builder)
    dealsPB.forEach(d => {
      const id = d.Builder?.id;
      if (!id || !map[id]) return;
      map[id].presBooked += 1;
      if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
    });

    // Aggregate deals — Presentation_Completed_Date (Builder)
    dealsPC.forEach(d => {
      const id = d.Builder?.id;
      if (!id || !map[id]) return;
      map[id].presCompleted += 1;
      if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
    });

    const builders = Object.values(map).map(b => ({ ...b, minutes: Math.round(b.minutes) }));
    return res.status(200).json({ builders, date, slot, role });

  } catch (e) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
