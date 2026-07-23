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

    async function coql(query) {
      const r = await fetch(`${API_DOMAIN}/crm/v2/coql`, {
        method: "POST", headers: h, body: JSON.stringify({ select_query: query }),
      });
      const status = r.status;
      if (status === 204) return { data: [], more: false, status };
      const d = await r.json();
      return { data: d?.data || [], more: !!d?.info?.more_records, status, raw: d };
    }
    async function coqlAll(baseQuery) {
      let all = [], offset = 0, firstRaw = null, firstStatus = null;
      while (true) {
        const { data, more, status, raw } = await coql(`${baseQuery} limit ${offset}, 200`);
        if (firstRaw === null) { firstRaw = raw; firstStatus = status; }
        all = all.concat(data);
        if (!more || data.length < 200) break;
        offset += 200;
        if (offset >= 2000) break;
      }
      return { all, firstStatus, firstRaw };
    }

    // Does the field exist / what values does it actually hold?
    const leadsRes = await coqlAll(
      `select id, Owner, New_Lead_Worked_Date, Last_Call_Outcome from Leads where New_Lead_Worked_Date >= '${startDate}' and New_Lead_Worked_Date <= '${endDate}'`
    );
    const contactsRes = await coqlAll(
      `select id, Owner, New_Lead_Worked_Date, Last_Call_Outcome from Contacts where New_Lead_Worked_Date >= '${startDate}' and New_Lead_Worked_Date <= '${endDate}'`
    );

    function tally(rows) {
      const counts = {};
      rows.forEach(r => {
        const v = r.Last_Call_Outcome === undefined ? "<<field missing from response>>"
                : r.Last_Call_Outcome === null ? "<<null/empty>>"
                : r.Last_Call_Outcome;
        counts[v] = (counts[v] || 0) + 1;
      });
      return counts;
    }

    return res.status(200).json({
      dateRange: [startDate, endDate],
      leads: {
        total_touched: leadsRes.all.length,
        last_call_outcome_value_counts: tally(leadsRes.all),
        connected_count_exact_match: leadsRes.all.filter(r => r.Last_Call_Outcome === "Connected").length,
        query_status: leadsRes.firstStatus,
        sample_record: leadsRes.all[0] || null,
      },
      contacts: {
        total_touched: contactsRes.all.length,
        last_call_outcome_value_counts: tally(contactsRes.all),
        connected_count_exact_match: contactsRes.all.filter(r => r.Last_Call_Outcome === "Connected").length,
        query_status: contactsRes.firstStatus,
        sample_record: contactsRes.all[0] || null,
      },
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
