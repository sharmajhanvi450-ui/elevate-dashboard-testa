export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
  const API_DOMAIN    = "https://www.zohoapis.in";

  try {
    const tr = await fetch("https://accounts.zoho.in/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    const td = await tr.json();
    if (!td.access_token) return res.status(500).json({ error: "Auth failed", detail: td });
    const token = td.access_token;
    const h = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" };

    async function coqlAll(baseQuery) {
      let all = [], offset = 0;
      while (true) {
        const r = await fetch(`${API_DOMAIN}/crm/v2/coql`, {
          method: "POST", headers: h, body: JSON.stringify({ select_query: `${baseQuery} limit ${offset}, 200` }),
        });
        if (r.status === 204) break;
        const d = await r.json();
        if (!d?.data?.length) break;
        all = all.concat(d.data);
        if (!d.info?.more_records) break;
        offset += 200;
        if (offset >= 2000) break;
      }
      return all;
    }

    const monthStart = req.query.monthStart || "2026-07-01";
    const monthEnd   = req.query.monthEnd   || "2026-07-31";

    // All-time, no date filter — should be close to the "500" Zoho shows
    const allTimeLeads = await coqlAll(`select id, Owner from Leads where Connectivity = 'Connected'`);
    const allTimeContacts = await coqlAll(`select id, Owner from Contacts where Connectivity = 'Connected'`);
    const allTimeDeals = await coqlAll(`select id, Owner from Deals where Connectivity = 'Connected'`);

    // This month only (New_Lead_Worked_Date in range) + Connectivity — what the dashboard computes
    const monthLeads = await coqlAll(`select id, Owner from Leads where New_Lead_Worked_Date >= '${monthStart}' and New_Lead_Worked_Date <= '${monthEnd}' and Connectivity = 'Connected'`);
    const monthContacts = await coqlAll(`select id, Owner from Contacts where New_Lead_Worked_Date >= '${monthStart}' and New_Lead_Worked_Date <= '${monthEnd}' and Connectivity = 'Connected'`);
    const monthDeals = await coqlAll(`select id, Owner from Deals where New_Lead_Worked_Date >= '${monthStart}' and New_Lead_Worked_Date <= '${monthEnd}' and Connectivity = 'Connected'`);

    // How many Connected leads have a New_Lead_Worked_Date OUTSIDE this month (or null)?
    const leadsConnectedButNotWorkedThisMonth = allTimeLeads.length - monthLeads.length;

    return res.status(200).json({
      monthRange: [monthStart, monthEnd],
      all_time: {
        leads: allTimeLeads.length,
        contacts: allTimeContacts.length,
        deals: allTimeDeals.length,
        total: allTimeLeads.length + allTimeContacts.length + allTimeDeals.length,
      },
      this_month_only: {
        leads: monthLeads.length,
        contacts: monthContacts.length,
        deals: monthDeals.length,
        total: monthLeads.length + monthContacts.length + monthDeals.length,
      },
      leads_connected_but_worked_outside_this_month: leadsConnectedButNotWorkedThisMonth,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
