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

    const date = req.query.date || "2026-07-22";
    const owner = req.query.owner || "Avni Gajjar";

    async function coql(query) {
      const r = await fetch(`${API_DOMAIN}/crm/v2/coql`, {
        method: "POST", headers: h, body: JSON.stringify({ select_query: query }),
      });
      if (r.status === 204) return [];
      const d = await r.json();
      return d?.data || [];
    }

    // Method A: two half-day IST windows (what report.js currently does)
    const winA1 = await coql(`select id, Owner, Call_Start_Time, Call_Type, Call_Status from Calls where Call_Start_Time between '${date}T00:00:00+05:30' and '${date}T14:59:59+05:30' limit 0, 200`);
    const winA2 = await coql(`select id, Owner, Call_Start_Time, Call_Type, Call_Status from Calls where Call_Start_Time between '${date}T15:00:00+05:30' and '${date}T23:59:59+05:30' limit 0, 200`);
    const allA = [...winA1, ...winA2].filter(c => c.Owner?.name === owner);

    // Method B: single full-day window, no split — isolates whether splitting causes double-count
    const winB = await coql(`select id, Owner, Call_Start_Time, Call_Type, Call_Status from Calls where Call_Start_Time between '${date}T00:00:00+05:30' and '${date}T23:59:59+05:30' limit 0, 200`);
    const allB = winB.filter(c => c.Owner?.name === owner);

    // Method C: no timezone suffix at all — isolates whether Zoho ignores/mishandles +05:30
    const winC = await coql(`select id, Owner, Call_Start_Time, Call_Type, Call_Status from Calls where Call_Start_Time between '${date}T00:00:00' and '${date}T23:59:59' limit 0, 200`);
    const allC = winC.filter(c => c.Owner?.name === owner);

    // Duplicate-id check within method A (would prove the two windows overlap)
    const idsA = allA.map(c => c.id);
    const dupIdsA = idsA.filter((id, i) => idsA.indexOf(id) !== i);

    const summarize = arr => ({
      total: arr.length,
      byType: arr.reduce((m, c) => { m[c.Call_Type || "?"] = (m[c.Call_Type || "?"]||0)+1; return m; }, {}),
      byStatus: arr.reduce((m, c) => { m[c.Call_Status || "?"] = (m[c.Call_Status || "?"]||0)+1; return m; }, {}),
      minTime: arr.length ? arr.map(c=>c.Call_Start_Time).sort()[0] : null,
      maxTime: arr.length ? arr.map(c=>c.Call_Start_Time).sort().at(-1) : null,
    });

    return res.status(200).json({
      date, owner,
      methodA_twoWindows: summarize(allA),
      methodA_window1_raw_count: winA1.length,
      methodA_window2_raw_count: winA2.length,
      methodA_duplicate_ids_across_windows: [...new Set(dupIdsA)],
      methodB_singleWindow: summarize(allB),
      methodC_noOffset: summarize(allC),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
