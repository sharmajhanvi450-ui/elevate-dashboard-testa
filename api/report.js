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
    if (r.status === 204) return {};
    return r.json();
  }

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

  // Fetch all calls where Call_Start_Time falls within [startDate, endDate]
  async function fetchCallsForRange(token, startDate, endDate, fields) {
    let all = [];
    const BATCH = 5;
    for (let start = 1; start <= 200; start += BATCH) {
      const pages = Array.from({ length: BATCH }, (_, i) => start + i);
      const results = await Promise.all(pages.map(p =>
        fetch(`${API_DOMAIN}/crm/v2/Calls?fields=${fields}&per_page=200&page=${p}&sort_by=Call_Start_Time&sort_order=desc`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } }).then(r => r.json())
      ));
      let done = false;
      for (const data of results) {
        if (!data?.data?.length) { done = true; break; }
        for (const record of data.data) {
          const d = parseZohoDate(record.Call_Start_Time);
          if (d && d >= startDate && d <= endDate) all.push(record);
        }
        const oldestDate = parseZohoDate(data.data.at(-1)?.Call_Start_Time);
        if (oldestDate && oldestDate < startDate) { done = true; break; }
        if (!data.info?.more_records) { done = true; break; }
      }
      if (done) break;
    }
    return all;
  }

  // Uses /search with between for date ranges (single date: startDate === endDate uses equals)
  async function fetchByCriteria(token, module, fields, startDate, endDate, dateField) {
    const criteria = startDate === endDate
      ? `(${dateField}:equals:${startDate})`
      : `(${dateField}:between:${startDate},${endDate})`;
    let all = [], page = 1;
    while (true) {
      const url = `${API_DOMAIN}/crm/v2/${module}/search?fields=${fields}&criteria=${criteria}&per_page=200&page=${page}`;
      const data = await zohoGet(token, url);
      if (!data?.data?.length) break;
      all = all.concat(data.data);
      if (!data.info?.more_records) break;
      page++;
    }
    return all;
  }

  try {
    const q = req.method === "POST" ? req.body : req.query;
    const { slot, role } = q;
    // Support both single `date` and `startDate`/`endDate`
    const startDate = q.startDate || q.date;
    const endDate   = q.endDate   || q.date;

    if (!startDate || !endDate || !slot || !role) {
      return res.status(400).json({ error: "Missing startDate, endDate, slot or role" });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: "startDate must be on or before endDate" });
    }

    const token = await getAccessToken();

    const ud = await zohoGet(token, `${API_DOMAIN}/crm/v2/users?type=ActiveUsers&per_page=200`);
    const allUsers = ud?.users || [];
    const users = allUsers.filter(u => (u.role?.name || "").toLowerCase().includes(role.toLowerCase()));

    if (!users.length) {
      const roleNames = [...new Set(allUsers.map(u => u.role?.name).filter(Boolean))];
      return res.status(404).json({ error: `No users found matching "${role}".`, available_roles: roleNames });
    }

    const isCloser = role.toLowerCase().includes("closer");

    // ── CLOSER REPORT ────────────────────────────────────────────────────────
    if (isCloser) {
      const map = {};
      users.forEach(u => {
        map[u.id] = { name: u.full_name, id: u.id, teamLead: "",
          calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0,
          presentations: 0, dealsClosed: 0, newUpfront: 0, futureUpfront: 0 };
      });

      const CALL_FIELDS = "Owner,Call_Duration_in_seconds,Call_Start_Time,Call_Type,Call_Status";
      const [calls, presHeld, closedDeals, upfrontDeals] = await Promise.all([
        fetchCallsForRange(token, startDate, endDate, CALL_FIELDS),
        fetchByCriteria(token, "Deals", "Owner,Team_Lead", startDate, endDate, "Presentation_Completed_Date"),
        fetchByCriteria(token, "Deals", "Owner,Future_Booked_Upfront,Team_Lead", startDate, endDate, "Deal_Closed_Date"),
        fetchByCriteria(token, "Deals", "Owner,Upfront_Amount,Team_Lead", startDate, endDate, "Upfront_Amount_Received_Date"),
      ]);

      calls.forEach(c => {
        const id = c.Owner?.id;
        if (!map[id]) return;
        if (c.Call_Status === "Missed") { map[id].missed += 1; return; }
        if (c.Call_Type === "Inbound")  { map[id].inbound += 1; return; }
        map[id].calls += 1;
        map[id].outbound += 1;
        map[id].minutes += (parseFloat(c.Call_Duration_in_seconds || 0) / 60);
      });

      presHeld.forEach(d => {
        const id = d.Owner?.id;
        if (!map[id]) return;
        map[id].presentations += 1;
        if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
      });

      closedDeals.forEach(d => {
        const id = d.Owner?.id;
        if (!map[id]) return;
        map[id].futureUpfront += parseFloat(d.Future_Booked_Upfront || 0);
        if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
      });

      upfrontDeals.forEach(d => {
        const id = d.Owner?.id;
        if (!map[id]) return;
        map[id].dealsClosed += 1;
        map[id].newUpfront += parseFloat(d.Upfront_Amount || 0);
        if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead;
      });

      const closers = Object.values(map).map(b => ({
        ...b,
        minutes: Math.round(b.minutes),
        newUpfront: Math.round(b.newUpfront),
        futureUpfront: Math.round(b.futureUpfront),
        revenue: Math.round(b.newUpfront + b.futureUpfront),
      }));
      return res.status(200).json({ closers, startDate, endDate, slot, role });
    }

    // ── BUILDER REPORT ───────────────────────────────────────────────────────
    const map = {};
    users.forEach(u => {
      map[u.id] = { name: u.full_name, id: u.id, teamLead: "",
        calls: 0, inbound: 0, outbound: 0, missed: 0, minutes: 0,
        leads: 0, discoveries: 0, presBooked: 0, presCompleted: 0 };
    });

    const CALL_FIELDS = "Owner,Call_Duration_in_seconds,Call_Start_Time,Call_Type,Call_Status";
    const [calls, leadsQL, leadsDisc, dealsQL, dealsDisc, dealsPB, dealsPC] = await Promise.all([
      fetchCallsForRange(token, startDate, endDate, CALL_FIELDS),
      fetchByCriteria(token, "Leads", "Owner,Team_Lead", startDate, endDate, "Qualified_Lead_Date"),
      fetchByCriteria(token, "Leads", "Owner,Team_Lead", startDate, endDate, "Discovery_Completed_Date"),
      fetchByCriteria(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Qualified_Lead_Date"),
      fetchByCriteria(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Discovery_Completed_Date"),
      fetchByCriteria(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Presentation_Booked_Date"),
      fetchByCriteria(token, "Deals", "Owner,Builder,Team_Lead", startDate, endDate, "Presentation_Completed_Date"),
    ]);

    calls.forEach(c => {
      const id = c.Owner?.id;
      if (!map[id]) return;
      if (c.Call_Status === "Missed") { map[id].missed += 1; return; }
      if (c.Call_Type === "Inbound")  { map[id].inbound += 1; return; }
      map[id].calls += 1;
      map[id].outbound += 1;
      map[id].minutes += (parseFloat(c.Call_Duration_in_seconds || 0) / 60);
    });

    leadsQL.forEach(l => { const id = l.Owner?.id; if (!map[id]) return; map[id].leads += 1; if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead; });
    leadsDisc.forEach(l => { const id = l.Owner?.id; if (!map[id]) return; map[id].discoveries += 1; if (!map[id].teamLead && l.Team_Lead) map[id].teamLead = l.Team_Lead; });
    dealsQL.forEach(d => { const id = d.Builder?.id; if (!id || !map[id]) return; map[id].leads += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; });
    dealsDisc.forEach(d => { const id = d.Builder?.id; if (!id || !map[id]) return; map[id].discoveries += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; });
    dealsPB.forEach(d => { const id = d.Builder?.id; if (!id || !map[id]) return; map[id].presBooked += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; });
    dealsPC.forEach(d => { const id = d.Builder?.id; if (!id || !map[id]) return; map[id].presCompleted += 1; if (!map[id].teamLead && d.Team_Lead) map[id].teamLead = d.Team_Lead; });

    const builders = Object.values(map).map(b => ({ ...b, minutes: Math.round(b.minutes) }));
    return res.status(200).json({ builders, startDate, endDate, slot, role });

  } catch (e) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
