// api/dbg.js — TEMPORARY debug: returns raw Zoho COQL response for a day's Calls.
// Protected by CRON_SECRET. Delete after debugging.
export const config = { maxDuration: 60 };

const API_DOMAIN = "https://www.zohoapis.in";

async function getToken(){
  const r = await fetch("https://accounts.zoho.in/oauth/v2/token", {
    method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams({
      grant_type:"refresh_token",
      refresh_token:process.env.ZOHO_REFRESH_TOKEN,
      client_id:process.env.ZOHO_CLIENT_ID,
      client_secret:process.env.ZOHO_CLIENT_SECRET,
    }),
  });
  return (await r.json()).access_token;
}

export default async function handler(req, res){
  if (req.query.secret !== process.env.CRON_SECRET) return res.status(401).json({ error:"unauthorized" });
  const date = req.query.date || "2026-06-01";
  try {
    const token = await getToken();
    const crit = `(Call_Start_Time:between:${date}T00:00:00+05:30,${date}T23:59:59+05:30)`;
    const url = `${API_DOMAIN}/crm/v2/Calls/search?fields=Owner,Call_Duration_in_seconds,Call_Start_Time,Call_Type,Call_Status`
              + `&criteria=${encodeURIComponent(crit)}&per_page=5&page=1`;
    const r = await fetch(url, { headers:{ Authorization:`Zoho-oauthtoken ${token}` } });
    const status = r.status;
    let body; if (status === 204) body = "(204 no content)"; else { try { body = await r.json(); } catch { body = await r.text(); } }
    return res.status(200).json({ date, search_status: status, criteria: crit, count: body?.data?.length ?? 0, response: body });
  } catch(e){
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
