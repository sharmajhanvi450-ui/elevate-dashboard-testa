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
      return { data: d?.data || [], more: !!d?.info?.more_records, raw_error: d?.message };
    }
    async function coqlAll(baseQuery) {
      let all = [], offset = 0;
      while (true) {
        const { data, more } = await coql(`${baseQuery} limit ${offset}, 200`);
        all = all.concat(data);
        if (!more || data.length < 200) break;
        offset += 200;
        if (offset >= 2000) break;
      }
      return all;
    }

    // Resolve owner name -> id so filtering is exact regardless of Owner object shape
    const usersResp = await fetch(`${API_DOMAIN}/crm/v2/users?type=AllUsers&per_page=200`, { headers: h });
    const usersJson = await usersResp.json().catch(()=>({}));
    const ownerUser = (usersJson.users||[]).find(u => u.full_name === owner);
    const ownerId = ownerUser?.id;

    const matchesOwner = c => ownerId ? String(c.Owner?.id) === String(ownerId) : c.Owner?.name === owner;

    // Instant of 00:00:00 America/New_York on `dateStr`, as a UTC Date — DST-safe
    // (resolves the actual NY offset for that specific date instead of assuming
    // a fixed -04:00/-05:00, which would be wrong on the other side of a DST flip).
    function nyMidnightUTC(dateStr) {
      const [y, m, d] = dateStr.split("-").map(Number);
      const noonGuessUTC = new Date(Date.UTC(y, m - 1, d, 16, 0, 0)); // ~noon ET, any DST state
      const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      const p = dtf.formatToParts(noonGuessUTC).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
      const offsetMin = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - noonGuessUTC.getTime()) / 60000;
      return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60000);
    }
    const dayStartUTC = nyMidnightUTC(date);
    const dayEndUTC = new Date(dayStartUTC.getTime() + 24 * 60 * 60 * 1000 - 1000);

    // Method D: correct Eastern-time calendar day boundary
    const winD = await coqlAll(`select id, Owner, Call_Start_Time, Call_Type, Call_Status from Calls where Call_Start_Time between '${dayStartUTC.toISOString()}' and '${dayEndUTC.toISOString()}'`);
    const allD = winD.filter(matchesOwner);

    // Method A: two half-day IST windows (what report.js currently does — the bug)
    const winA1 = await coqlAll(`select id, Owner, Call_Start_Time, Call_Type, Call_Status from Calls where Call_Start_Time between '${date}T00:00:00+05:30' and '${date}T14:59:59+05:30'`);
    const winA2 = await coqlAll(`select id, Owner, Call_Start_Time, Call_Type, Call_Status from Calls where Call_Start_Time between '${date}T15:00:00+05:30' and '${date}T23:59:59+05:30'`);
    const allA = [...winA1, ...winA2].filter(matchesOwner);

    const summarize = arr => ({
      total: arr.length,
      byType: arr.reduce((m, c) => { m[c.Call_Type || "?"] = (m[c.Call_Type || "?"]||0)+1; return m; }, {}),
      byStatus: arr.reduce((m, c) => { m[c.Call_Status || "?"] = (m[c.Call_Status || "?"]||0)+1; return m; }, {}),
      minTime: arr.length ? arr.map(c=>c.Call_Start_Time).sort()[0] : null,
      maxTime: arr.length ? arr.map(c=>c.Call_Start_Time).sort().at(-1) : null,
    });

    return res.status(200).json({
      date, owner,
      methodD_easternDayBoundary: summarize(allD),
      methodD_window_utc: [dayStartUTC.toISOString(), dayEndUTC.toISOString()],
      methodA_twoWindows_IST_buggy: summarize(allA),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
