const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_EMAILS = ["aman.p@elevateme.pro", "satish.r@elevateme.pro", "shani@elevateme.pro", "prachit@elevateme.pro"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  // Verify token with Supabase and get user
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` }
  });
  const user = await userRes.json();
  if (!user?.email) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "POST") {
    // Any authenticated @elevateme.pro user can log activity
    const { email, full_name, avatar_url, action, role, date_range } = req.body;
    await fetch(`${SUPABASE_URL}/rest/v1/user_activity`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, full_name, avatar_url, action, role, date_range })
    });
    return res.status(200).json({ ok: true });
  }

  // GET — admin only
  if (!ADMIN_EMAILS.includes(user.email)) {
    return res.status(403).json({ error: "Access denied — admin only" });
  }

  // GET — return activity log
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_activity?select=*&order=created_at.desc&limit=200`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await r.json();

  // Active in last 30 min
  const now = Date.now();
  const active = [...new Map(
    rows
      .filter(r => now - new Date(r.created_at).getTime() < 30 * 60 * 1000)
      .map(r => [r.email, r])
  ).values()];

  return res.status(200).json({ activity: rows, active_users: active });
}
