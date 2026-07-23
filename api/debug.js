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

    async function coql(query) {
      const r = await fetch(`${API_DOMAIN}/crm/v2/coql`, {
        method: "POST", headers: h, body: JSON.stringify({ select_query: query }),
      });
      const status = r.status;
      if (status === 204) return { status, count: 0, error: null };
      const d = await r.json();
      return { status, count: d?.data?.length || 0, error: d?.message || null, sample: d?.data?.[0] || null };
    }

    const tests = {
      "no_where_at_all": await coql(`select id, Connectivity from Leads limit 0, 5`),
      "is_not_null": await coql(`select id, Connectivity from Leads where Connectivity is not null limit 0, 5`),
      "eq_connected_bare": await coql(`select id, Connectivity from Leads where Connectivity = 'Connected' limit 0, 5`),
      "eq_connected_in_op": await coql(`select id, Connectivity from Leads where Connectivity in ('Connected') limit 0, 5`),
      "eq_connected_lowercase": await coql(`select id, Connectivity from Leads where Connectivity = 'connected' limit 0, 5`),
      "combined_with_and": await coql(`select id, Connectivity, New_Lead_Worked_Date from Leads where New_Lead_Worked_Date = '2026-07-03' and Connectivity is not null limit 0, 5`),
    };

    return res.status(200).json(tests);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
