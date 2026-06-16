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
        grant_type:    "refresh_token",
        refresh_token: REFRESH_TOKEN,
        client_id:     CLIENT_ID,
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

  async function fetchModule(token, module, dateField, date) {
    const url = `${API_DOMAIN}/crm/v2/${module}?fields=Owner,Builder,Qualified_Lead_Date,Discovery_Completed_Date,Presentation_Booked_Date,Team_Lead&criteria=(${dateField}:equals:${date})&per_page=200`;
    const data = await zohoGet(token, url);
    return data?.data || [];
  }

  try {
    const { date, slot, role } = req.method === "POST" ? req.body : req.query;
    if (!date || !slot || !role) return res.status(400).json({ error: "Missing date, slot or role" });

    const token = await getAccessToken();

    // Fetch ALL active users and return role names for debugging + filter
    const ud = await zohoGet(token, `${API_DOMAIN}/crm/v2/users?type=ActiveUsers`);
    const allUsers = ud?.users || [];

    // role param is "Builder" or "Closer" — match role name containing that keyword (case-insensitive)
    const users = allUsers.filter(u => {
      const roleName = (u.role?.name || "").toLowerCase();
      return roleName.includes(role.toLowerCase());
    });

    // For debugging — return all role names if no match
    if (!users.length) {
      const roleNames = [...new Set(allUsers.map(u => u.role?.name).filter(Boolean))];
      return res.status(404).json({
        error: `No active users found with "${role}" in role name.`,
        available_roles: roleNames
      });
    }

    const map = {};
    users.forEach(u => {
      map[u.id] = {
        name: u.full_name, id: u.id, teamLead: "",
        calls: 0, minutes: 0, leads: 0, discoveries: 0, presentations: 0
      };
    });

    // Calls — use IST date range (UTC+5:30)
    const dateStart = `${date}T00:00:00+05:30`;
    const dateEnd   = `${date}T23:59:59+05:30`;
    const cd = await zohoGet(token, `${API_DOMAIN}/crm/v2/Calls?fields=Owner,Duration_in_minutes,Call_Start_Time&criteria=(Call_Start_Time:between:${dateStart},${dateEnd})&per_page=200`);
    (cd?.data || []).forEach(c => {
      const id = c.Owner?.id;
      if (map[id]) { map[id].calls += 1; map[id].minutes += parseFloat(c.Duration_in_minutes || 0); }
    });

    // Leads - qualified
    (await fetchModule(token, "Leads", "Qualified_Lead_Date", date)).forEach(l => {
      const id = l.Owner?.id;
      if (map[id]) { map[id].leads += 1; if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead; }
    });

    // Leads - discovery
    (await fetchModule(token, "Leads", "Discovery_Completed_Date", date)).forEach(l => {
      const id = l.Owner?.id;
      if (map[id]) { map[id].discoveries += 1; if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead; }
    });

    // Deals - qualified leads (Builder field)
    (await fetchModule(token, "Deals", "Qualified_Lead_Date", date)).forEach(d => {
      const id = d.Builder?.id;
      if (id && map[id]) { map[id].leads += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; }
    });

    // Deals - discovery (Builder field)
    (await fetchModule(token, "Deals", "Discovery_Completed_Date", date)).forEach(d => {
      const id = d.Builder?.id;
      if (id && map[id]) { map[id].discoveries += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; }
    });

    // Deals - presentations booked (Builder field)
    (await fetchModule(token, "Deals", "Presentation_Booked_Date", date)).forEach(d => {
      const id = d.Builder?.id;
      if (id && map[id]) { map[id].presentations += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; }
    });

    const builders = Object.values(map).map(b => ({ ...b, minutes: Math.round(b.minutes) }));
    return res.status(200).json({ builders, date, slot, role });

  } catch (e) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
