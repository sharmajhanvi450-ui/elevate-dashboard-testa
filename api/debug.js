export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

  try {
    // Get token
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

    // Fetch all users
    const ur = await fetch("https://www.zohoapis.in/crm/v2/users?type=AllUsers&per_page=200", {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const ud = await ur.json();
    const users = ud?.users || [];

    // Return each user's name, role name and status
    const result = users.map(u => ({
      name: u.full_name,
      role: u.role?.name,
      status: u.status
    }));

    return res.status(200).json({ total: users.length, users: result });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
