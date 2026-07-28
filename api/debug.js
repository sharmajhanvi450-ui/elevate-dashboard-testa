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

    async function coqlAll(baseQuery, cap = 2000) {
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
        if (offset >= cap) break;
      }
      return all;
    }

    // Sample of Connected leads with their actual New_Lead_Worked_Date + Modified_Time
    const sample = await coqlAll(
      `select id, Owner, New_Lead_Worked_Date, Modified_Time, Lead_Assigned_Date, Qualified_Lead_Date from Leads where Connectivity = 'Connected'`,
      200
    );

    const dateBuckets = {};
    sample.forEach(r => {
      const v = r.New_Lead_Worked_Date;
      const key = v ? String(v).slice(0, 7) : "<<null>>"; // YYYY-MM
      dateBuckets[key] = (dateBuckets[key] || 0) + 1;
    });

    // Total leads (any Connectivity) whose New_Lead_Worked_Date is in July, to
    // check whether the field itself has ANY July data at all.
    const anyJulyWorked = await coqlAll(
      `select id from Leads where New_Lead_Worked_Date >= '2026-07-01' and New_Lead_Worked_Date <= '2026-07-31'`,
      200
    );

    return res.status(200).json({
      sample_size: sample.length,
      new_lead_worked_date_month_distribution: dateBuckets,
      sample_records: sample.slice(0, 5),
      any_leads_worked_in_july_regardless_of_connectivity: anyJulyWorked.length,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
