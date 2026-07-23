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

    // Field metadata for Leads module — find the real API name/type of any
    // field whose label or API name looks like "Connectivity".
    const fieldsResp = await fetch(`${API_DOMAIN}/crm/v2/settings/fields?module=Leads`, { headers: h });
    const fieldsJson = await fieldsResp.json();
    const matches = (fieldsJson.fields || []).filter(f =>
      (f.api_name || "").toLowerCase().includes("connect") ||
      (f.field_label || "").toLowerCase().includes("connect")
    );

    return res.status(200).json({
      matches: matches.map(f => ({
        api_name: f.api_name,
        field_label: f.field_label,
        data_type: f.data_type,
        pick_list_values: f.pick_list_values?.map(p => p.actual_value) || null,
      })),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
