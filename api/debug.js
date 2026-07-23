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

    const startDate = req.query.start || "2026-07-01";
    const endDate   = req.query.end   || "2026-07-23";

    function makeLimiter(max) {
      let active = 0; const q = [];
      const pump = () => { while (active < max && q.length) { active++; (q.shift())(); } };
      return fn => new Promise((resolve, reject) => {
        q.push(() => fn().then(resolve, reject).finally(() => { active--; pump(); }));
        pump();
      });
    }
    const _limit = makeLimiter(8);
    async function zohoFetch(url, opts) {
      return _limit(async () => {
        for (let attempt = 0; ; attempt++) {
          const r = await fetch(url, opts);
          if ((r.status === 429 || r.status >= 500) && attempt < 6) {
            await new Promise(res => setTimeout(res, Math.min(800 * 2 ** attempt, 12000) + Math.floor(Math.random() * 300)));
            continue;
          }
          return r;
        }
      });
    }

    // EXACT replica of funnel.js's fetchByDateRange (per-day equality loop)
    async function fetchByDateRange(module, select, startDate, endDate, dateField, extraWhere) {
      const dates = [];
      const d = new Date(startDate + "T12:00:00Z");
      const end = new Date(endDate + "T12:00:00Z");
      while (d <= end) { dates.push(d.toISOString().split("T")[0]); d.setUTCDate(d.getUTCDate() + 1); }

      async function fetchOneDay(date) {
        let all = [], offset = 0;
        while (true) {
          let where = `${dateField} = '${date}'`;
          if (extraWhere) where += ` and ${extraWhere}`;
          const q = `select ${select} from ${module} where ${where} limit ${offset}, 200`;
          const r = await zohoFetch(`${API_DOMAIN}/crm/v2/coql`, {
            method: "POST", headers: h, body: JSON.stringify({ select_query: q }),
          });
          if (r.status === 204) break;
          const data = await r.json();
          if (!data?.data?.length) {
            if (data?.message && !all.length) console.error(`COQL error for ${module} ${date}:`, JSON.stringify(data));
            break;
          }
          all = all.concat(data.data);
          if (!data.info?.more_records) break;
          offset += 200;
          if (offset >= 2000) break;
        }
        return all;
      }

      let all = [], perDayCounts = {};
      const BATCH = 5;
      for (let i = 0; i < dates.length; i += BATCH) {
        const batch = dates.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(fetchOneDay));
        batch.forEach((date, idx) => { perDayCounts[date] = results[idx].length; });
        results.forEach(r => { all = all.concat(r); });
      }
      return { all, perDayCounts };
    }

    const commonFields = "id, Owner, Lead_Generated_Date";

    const [touchedLeadsRes, touchedContactsRes, connectedLeadsRes, connectedContactsRes] = await Promise.all([
      fetchByDateRange("Leads",    commonFields, startDate, endDate, "New_Lead_Worked_Date"),
      fetchByDateRange("Contacts", commonFields, startDate, endDate, "New_Lead_Worked_Date"),
      fetchByDateRange("Leads",    commonFields, startDate, endDate, "New_Lead_Worked_Date", "Last_Call_Outcome = 'Connected'"),
      fetchByDateRange("Contacts", commonFields, startDate, endDate, "New_Lead_Worked_Date", "Last_Call_Outcome = 'Connected'"),
    ]);

    return res.status(200).json({
      dateRange: [startDate, endDate],
      touched_leads_total: touchedLeadsRes.all.length,
      touched_contacts_total: touchedContactsRes.all.length,
      touched_total: touchedLeadsRes.all.length + touchedContactsRes.all.length,
      connected_leads_total: connectedLeadsRes.all.length,
      connected_contacts_total: connectedContactsRes.all.length,
      connected_total: connectedLeadsRes.all.length + connectedContactsRes.all.length,
      connected_leads_per_day: connectedLeadsRes.perDayCounts,
      connected_contacts_per_day: connectedContactsRes.perDayCounts,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
