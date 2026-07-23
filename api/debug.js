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

    const startDate = req.query.start || "2026-07-01";
    const endDate   = req.query.end   || "2026-07-23";

    async function coql(query) {
      const r = await fetch(`${API_DOMAIN}/crm/v2/coql`, {
        method: "POST", headers: h, body: JSON.stringify({ select_query: query }),
      });
      const status = r.status;
      if (status === 204) return { data: [], status, raw: null };
      const d = await r.json();
      return { data: d?.data || [], status, raw: d };
    }

    // 1) Does the field even exist? Select it without any WHERE on it.
    const noFilter = await coql(`select id, Connectivity, New_Lead_Worked_Date from Leads where New_Lead_Worked_Date >= '${startDate}' and New_Lead_Worked_Date <= '${endDate}' limit 0, 25`);

    // 2) Try the exact filter the app uses
    const withFilter = await coql(`select id, Connectivity from Leads where New_Lead_Worked_Date >= '${startDate}' and New_Lead_Worked_Date <= '${endDate}' and Connectivity = 'Connected' limit 0, 25`);

    // 3) Tally whatever values Connectivity actually holds in the no-filter sample
    const counts = {};
    noFilter.data.forEach(r => {
      const v = r.Connectivity === undefined ? "<<field missing>>" : r.Connectivity === null ? "<<null>>" : r.Connectivity;
      counts[v] = (counts[v] || 0) + 1;
    });

    return res.status(200).json({
      dateRange: [startDate, endDate],
      no_filter_query_status: noFilter.status,
      no_filter_sample_count: noFilter.data.length,
      no_filter_sample_records: noFilter.data.slice(0, 5),
      connectivity_value_counts_in_sample: counts,
      with_filter_query_status: withFilter.status,
      with_filter_result_count: withFilter.data.length,
      with_filter_raw_error: withFilter.raw?.message || null,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
