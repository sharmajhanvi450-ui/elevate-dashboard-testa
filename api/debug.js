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

    async function coqlAll(baseQuery, cap = 2000) {
      let all = [], offset = 0;
      while (true) {
        const r = await fetch(`${API_DOMAIN}/crm/v2/coql`, {
          method: "POST", headers: h, body: JSON.stringify({ select_query: `${baseQuery} limit ${offset}, 200` }),
        });
        if (r.status === 204) break;
        const d = await r.json();
        if (!d?.data?.length) break;
        all = all.concat(d.data);
        if (!d.info?.more_records) break;
        offset += 200;
        if (offset >= cap) break;
      }
      return all;
    }

    const EXCLUDE_EMAILS = new Set(["bdteamleaders@elevateme.pro", "bde@elevateme.pro", "admissions@elevateme.pro"]);
    const usersResp = await fetch(`${API_DOMAIN}/crm/v2/users?type=AllUsers&per_page=200`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const usersJson = await usersResp.json().catch(() => ({}));
    const excludedIds = new Set((usersJson.users || []).filter(u => EXCLUDE_EMAILS.has((u.email || "").toLowerCase())).map(u => u.id));

    // Per-day loop (matches funnel.js exactly) for July, Leads+Contacts+Deals, Connectivity=Connected
    const dates = [];
    const d0 = new Date("2026-07-01T12:00:00Z"), d1 = new Date("2026-07-28T12:00:00Z");
    for (let d = new Date(d0); d <= d1; d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));

    async function fetchDay(date) {
      const [l, c, dl] = await Promise.all([
        coqlAll(`select id, Owner from Leads where New_Lead_Worked_Date = '${date}' and Connectivity = 'Connected'`),
        coqlAll(`select id, Owner from Contacts where New_Lead_Worked_Date = '${date}' and Connectivity = 'Connected'`),
        coqlAll(`select id, Owner from Deals where New_Lead_Worked_Date = '${date}' and Connectivity = 'Connected'`),
      ]);
      return [...l, ...c, ...dl];
    }
    let all = [];
    for (const date of dates) all = all.concat(await fetchDay(date));

    const kept = all.filter(r => !excludedIds.has(r.Owner?.id));
    const excluded = all.filter(r => excludedIds.has(r.Owner?.id));

    return res.status(200).json({
      total_this_month_before_exclusion: all.length,
      kept_after_owner_exclusion: kept.length,
      excluded_count: excluded.length,
      excluded_ids_found: excludedIds.size ? [...excludedIds] : [],
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
