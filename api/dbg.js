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
    const q = `SELECT Owner, Call_Duration_in_seconds, Call_Start_Time, Call_Type, Call_Status `
            + `FROM Calls WHERE Call_Start_Time between '${date}T00:00:00+05:30' and '${date}T23:59:59+05:30' LIMIT 0, 5`;
    const r = await fetch(`${API_DOMAIN}/crm/v2/coql`, {
      method:"POST",
      headers:{ Authorization:`Zoho-oauthtoken ${token}`, "Content-Type":"application/json" },
      body: JSON.stringify({ select_query: q }),
    });
    const status = r.status;
    let body; try { body = await r.json(); } catch { body = await r.text(); }
    return res.status(200).json({ date, coql_status: status, query: q, response: body });
  } catch(e){
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
