// api/exch.js — TEMPORARY: exchange a Zoho grant code for a refresh token using
// the project's ZOHO_CLIENT_ID/SECRET env vars. Protected by CRON_SECRET.
// Open in a browser:  /api/exch?code=<GRANT_CODE>&secret=<CRON_SECRET>
// Copy the returned refresh_token into the ZOHO_REFRESH_TOKEN env var.
// DELETE this file after use.
export const config = { maxDuration: 30 };

export default async function handler(req, res){
  if (req.query.secret !== process.env.CRON_SECRET) return res.status(401).json({ error:"unauthorized" });
  const code = req.query.code;
  if (!code) return res.status(400).json({ error:"pass ?code=<grant code>" });
  try {
    const r = await fetch("https://accounts.zoho.in/oauth/v2/token", {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:"authorization_code",
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        code,
      }),
    });
    const data = await r.json();
    return res.status(200).json(data);
  } catch(e){
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
