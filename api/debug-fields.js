let _tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const r = await fetch("https://accounts.zoho.in/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("Auth failed: " + JSON.stringify(data));
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return data.access_token;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.query.secret !== (process.env.CRON_SECRET || "elevate2024")) return res.status(401).json({ error: "Unauthorized" });

  const token = await getAccessToken();
  // Fetch one lead record with all fields
  const r = await fetch("https://www.zohoapis.in/crm/v2/Leads?per_page=1&page=1", {
    headers: { Authorization: `Zoho-oauthtoken ${token}` }
  });
  const data = await r.json();
  const record = data?.data?.[0] || {};
  // Return all field keys that contain "source" or "bde" (case insensitive)
  const allKeys = Object.keys(record);
  const relevant = allKeys.filter(k => k.toLowerCase().includes("source") || k.toLowerCase().includes("bde") || k.toLowerCase().includes("lead_source"));
  return res.status(200).json({ relevant_fields: relevant, all_keys: allKeys });
}
