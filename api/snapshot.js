// api/snapshot.js
// Daily EOD snapshot: pulls one day's raw KPIs for every Builder & Closer from
// Zoho, computes that day's score, and upserts one row per person into the
// Supabase `daily_kpi` table. Meant to run once per day via Vercel Cron
// (~00:30 EST, i.e. just after the previous workday closes).
//
// Auth: requires CRON_SECRET. Vercel Cron automatically sends it as
//   Authorization: Bearer <CRON_SECRET>
// Manual/backfill calls may pass ?secret=<CRON_SECRET>.
//
// Query params:
//   ?date=YYYY-MM-DD          snapshot a single specific day
//   ?start=..&end=..          backfill an inclusive range (keep small on Hobby)
//   (none)                    snapshot yesterday (EST)
//   ?force=1                  also snapshot weekends (normally skipped)

export const config = { maxDuration: 60 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-only, RLS bypass
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;         // read attendance
const CRON_SECRET  = process.env.CRON_SECRET;

const AUTH_DOMAIN = "https://accounts.zoho.in";
const API_DOMAIN  = "https://www.zohoapis.in";

// ── Scoring (mirrors public/index.html, cap enabled) ────────────────────────
const TARGETS        = { calls:150, minutes:180, leads:4, discoveries:2, presBooked:2, presCompleted:2 };
const WEIGHTS        = { calls:0.20, minutes:0.20, leads:0.10, discoveries:0.15, presBooked:0.10, presCompleted:0.25 };
const TARGETS_CLOSER = { calls:60, minutes:120, presentations:2 };
const WEIGHTS_CLOSER = { calls:0.40, minutes:0.20, presentations:0.40 };

const zone = s => s>=110?"gold":s>=95?"green":s>=75?"yellow":s>=50?"orange":"red";
const cap  = (v,tgt) => Math.min(150, tgt>0 ? (v/tgt)*100 : 0);

function scoreBuilder(b){
  return Math.round(
    cap(b.calls,TARGETS.calls)*WEIGHTS.calls +
    cap(b.minutes,TARGETS.minutes)*WEIGHTS.minutes +
    cap(b.leads,TARGETS.leads)*WEIGHTS.leads +
    cap(b.discoveries,TARGETS.discoveries)*WEIGHTS.discoveries +
    cap(b.presBooked,TARGETS.presBooked)*WEIGHTS.presBooked +
    cap(b.presCompleted,TARGETS.presCompleted)*WEIGHTS.presCompleted
  );
}
function scoreCloser(c){
  const k = cap(c.calls,TARGETS_CLOSER.calls)*WEIGHTS_CLOSER.calls +
            cap(c.minutes,TARGETS_CLOSER.minutes)*WEIGHTS_CLOSER.minutes +
            cap(c.presentations,TARGETS_CLOSER.presentations)*WEIGHTS_CLOSER.presentations;
  if (c.dealsClosed >= 2) return Math.round(Math.min(Math.max(k*1.50,110),150));
  if (c.dealsClosed === 1) return Math.round(Math.min(Math.max(k*1.25,95),125));
  return Math.round(Math.min(k,110));
}
const zoneCloser = (c,s) => (c.calls===0 && c.dealsClosed===0) ? "red" : zone(s);

function getTLName(roleName){
  if (roleName.includes("Soham"))   return "Soham";
  if (roleName.includes("Tejasvi")) return "Tejasvi";
  if (roleName.includes("Mamta"))   return "Mamta Das";
  return null;
}

// ── Zoho helpers ────────────────────────────────────────────────────────────
let _tok = { token:null, exp:0 };
async function getToken(){
  if (_tok.token && Date.now() < _tok.exp) return _tok.token;
  const r = await fetch(`${AUTH_DOMAIN}/oauth/v2/token`, {
    method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams({
      grant_type:"refresh_token",
      refresh_token:process.env.ZOHO_REFRESH_TOKEN,
      client_id:process.env.ZOHO_CLIENT_ID,
      client_secret:process.env.ZOHO_CLIENT_SECRET,
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Zoho auth failed: " + JSON.stringify(d));
  _tok = { token:d.access_token, exp:Date.now() + 50*60*1000 };
  return d.access_token;
}
async function zohoGet(token, url){
  const r = await fetch(url, { headers:{ Authorization:`Zoho-oauthtoken ${token}` } });
  if (r.status === 204) return {};
  return r.json();
}
function parseZohoDate(val){
  if (!val) return null;
  const m = val.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (m) return m[1];
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  try { const d = new Date(val + " UTC"); return isNaN(d) ? null : d.toISOString().split("T")[0]; }
  catch { return null; }
}
// COQL: fetch Calls whose Call_Start_Time is within [startDT, endDT],
// paginated up to COQL's ~2000-record ceiling.
async function coqlCalls(token, startDT, endDT){
  const out = [];
  let offset = 0;
  while (true){
    const q = `SELECT Owner, Call_Duration_in_seconds, Call_Start_Time, Call_Type, Call_Status `
            + `FROM Calls WHERE Call_Start_Time between '${startDT}' and '${endDT}' LIMIT ${offset}, 200`;
    const r = await fetch(`${API_DOMAIN}/crm/v2/coql`, {
      method:"POST",
      headers:{ Authorization:`Zoho-oauthtoken ${token}`, "Content-Type":"application/json" },
      body: JSON.stringify({ select_query: q }),
    });
    if (r.status === 204) break;
    const data = await r.json();
    if (!data?.data?.length) break;
    out.push(...data.data);
    if (!data.info?.more_records) break;
    offset += 200;
    if (offset >= 2000) break; // COQL offset ceiling
  }
  return out;
}

// Instant of 00:00:00 America/New_York on `dateStr`, as a UTC Date — DST-safe.
// The business runs on US Eastern hours, not IST — a fixed IST offset here
// was pulling in calls from the wrong 9.5-hour-shifted window and
// overcounting (confirmed against Zoho's own UI count: an IST window gave
// 242 calls for a day Zoho itself reports as 139).
function nyMidnightUTC(dateStr){
  const [y, m, d] = dateStr.split("-").map(Number);
  const noonGuessUTC = new Date(Date.UTC(y, m - 1, d, 16, 0, 0)); // ~noon ET regardless of DST
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = dtf.formatToParts(noonGuessUTC).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const offsetMin = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - noonGuessUTC.getTime()) / 60000;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60000);
}
const fmtCOQL = d => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");

// All Calls on `date` (Eastern-time calendar day). Uses COQL datetime range so
// ANY date works regardless of age. Split into two half-day windows so heavy
// days stay under COQL's 2000-record ceiling.
async function fetchCallsForDay(token, date){
  const dayStart = nyMidnightUTC(date);
  const dayMid   = new Date(dayStart.getTime() + 12 * 60 * 60 * 1000);
  const dayEnd   = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1000);
  const windows = [
    [fmtCOQL(dayStart), fmtCOQL(new Date(dayMid.getTime() - 1000))],
    [fmtCOQL(dayMid), fmtCOQL(dayEnd)],
  ];
  const all = [];
  for (const [s, e] of windows){ all.push(...await coqlCalls(token, s, e)); }
  return all;
}
// Records in a module whose `dateField` equals `date` (Zoho /search only supports equals)
async function fetchByDay(token, module, fields, date, dateField){
  let all = [], page = 1;
  while (true){
    const url = `${API_DOMAIN}/crm/v2/${module}/search?fields=${fields}&criteria=(${dateField}:equals:${date})&per_page=200&page=${page}`;
    const data = await zohoGet(token, url);
    if (!data?.data?.length) break;
    all = all.concat(data.data);
    if (!data.info?.more_records) break;
    page++;
  }
  return all;
}

// Names on leave for `date` (from Supabase attendance table)
async function fetchLeaveNames(date){
  if (!SUPABASE_URL) return new Set();
  const key = SERVICE_KEY || ANON_KEY;
  const url = `${SUPABASE_URL}/rest/v1/attendance?date=eq.${date}&status=eq.leave&select=person_name`;
  const r = await fetch(url, { headers:{ apikey:key, Authorization:`Bearer ${key}` } });
  if (!r.ok) return new Set();
  const rows = await r.json();
  return new Set((rows || []).map(x => x.person_name));
}

// Bulk upsert rows into daily_kpi (conflict on date+person_id)
async function upsertRows(rows){
  if (!rows.length) return { count:0 };
  const url = `${SUPABASE_URL}/rest/v1/daily_kpi?on_conflict=date,person_id`;
  const r = await fetch(url, {
    method:"POST",
    headers:{
      apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}`,
      "Content-Type":"application/json",
      Prefer:"resolution=merge-duplicates,return=minimal",
    },
    body:JSON.stringify(rows),
  });
  if (!r.ok){ const t = await r.text(); throw new Error(`Supabase upsert ${r.status}: ${t}`); }
  return { count: rows.length };
}

// ── Snapshot one day ────────────────────────────────────────────────────────
async function snapshotDay(date){
  const token = await getToken();

  const ud = await zohoGet(token, `${API_DOMAIN}/crm/v2/users?type=ActiveUsers&per_page=200`);
  const allUsers = ud?.users || [];

  const builderMap = {}, closerMap = {};
  allUsers.forEach(u => {
    const rn = u.role?.name || "";
    const tl = getTLName(rn);
    const base = { name:u.full_name, id:u.id, tlName:tl,
      calls:0, inbound:0, outbound:0, missed:0, minutes:0 };
    if (rn.includes("Closer"))      closerMap[u.id]  = { ...base, presentations:0, dealsClosed:0, newUpfront:0, futureUpfront:0 };
    else if (rn.includes("Builder")) builderMap[u.id] = { ...base, leads:0, discoveries:0, presBooked:0, presCompleted:0, dealsClosed:0 };
  });

  const [calls, presHeld, closedDeals, upfrontDeals,
         leadsQL, leadsDisc, dealsQL, dealsDisc, dealsPB, dealsPC, builderClosedDeals, leaveNames] =
    await Promise.all([
      fetchCallsForDay(token, date),
      fetchByDay(token, "Deals", "Owner,Team_Lead",                       date, "Presentation_Completed_Date"),
      fetchByDay(token, "Deals", "Owner,Future_Booked_Upfront,Team_Lead", date, "Deal_Closed_Date"),
      fetchByDay(token, "Deals", "Owner,Upfront_Amount,Team_Lead",        date, "Upfront_Amount_Received_Date"),
      fetchByDay(token, "Leads", "Owner,Team_Lead",                       date, "Qualified_Lead_Date"),
      fetchByDay(token, "Leads", "Owner,Team_Lead",                       date, "Discovery_Completed_Date"),
      fetchByDay(token, "Deals", "Owner,Builder,Team_Lead",               date, "Qualified_Lead_Date"),
      fetchByDay(token, "Deals", "Owner,Builder,Team_Lead",               date, "Discovery_Completed_Date"),
      fetchByDay(token, "Deals", "Owner,Builder,Team_Lead",               date, "Presentation_Booked_Date"),
      fetchByDay(token, "Deals", "Owner,Builder,Team_Lead",               date, "Presentation_Completed_Date"),
      fetchByDay(token, "Deals", "Owner,Builder,Team_Lead",               date, "Deal_Closed_Date"),
      fetchLeaveNames(date),
    ]);

  calls.forEach(c => {
    const id = c.Owner?.id ?? c.Owner;   // COQL may return Owner as id or object
    const mins = parseFloat(c.Call_Duration_in_seconds || 0) / 60;
    const map = builderMap[id] ? builderMap : closerMap[id] ? closerMap : null;
    if (!map) return;
    map[id].minutes += mins;
    if (c.Call_Status === "Missed") map[id].missed += 1;
    else if (c.Call_Type === "Inbound") map[id].inbound += 1;
    else { map[id].calls += 1; map[id].outbound += 1; }
  });

  // Builder KPIs
  leadsQL.forEach(l   => { const id=l.Owner?.id;   if(builderMap[id]) builderMap[id].leads++; });
  leadsDisc.forEach(l => { const id=l.Owner?.id;   if(builderMap[id]) builderMap[id].discoveries++; });
  dealsQL.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].leads++; });
  dealsDisc.forEach(d => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].discoveries++; });
  dealsPB.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].presBooked++; });
  dealsPC.forEach(d   => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].presCompleted++; });
  builderClosedDeals.forEach(d => { const id=d.Builder?.id; if(builderMap[id]) builderMap[id].dealsClosed++; });

  // Closer KPIs
  presHeld.forEach(d    => { const id=d.Owner?.id; if(closerMap[id]) closerMap[id].presentations++; });
  closedDeals.forEach(d => { const id=d.Owner?.id; if(closerMap[id]) closerMap[id].futureUpfront += parseFloat(d.Future_Booked_Upfront||0); });
  upfrontDeals.forEach(d=> { const id=d.Owner?.id; if(closerMap[id]) { closerMap[id].dealsClosed++; closerMap[id].newUpfront += parseFloat(d.Upfront_Amount||0); } });

  const rows = [];
  Object.values(builderMap).forEach(b => {
    const s = scoreBuilder(b);
    rows.push({
      date, person_id:b.id, person_name:b.name, role:"Builder", team_lead:b.tlName,
      calls:b.calls, inbound:b.inbound, outbound:b.outbound, missed:b.missed,
      minutes:Math.round(b.minutes),
      leads:b.leads, discoveries:b.discoveries, pres_booked:b.presBooked, pres_completed:b.presCompleted,
      presentations:0, deals_closed:b.dealsClosed, new_upfront:0, future_upfront:0,
      score:s, zone:zone(s), on_leave:leaveNames.has(b.name),
    });
  });
  Object.values(closerMap).forEach(c => {
    const s = scoreCloser(c);
    rows.push({
      date, person_id:c.id, person_name:c.name, role:"Closer", team_lead:c.tlName,
      calls:c.calls, inbound:c.inbound, outbound:c.outbound, missed:c.missed,
      minutes:Math.round(c.minutes),
      leads:0, discoveries:0, pres_booked:0, pres_completed:0,
      presentations:c.presentations, deals_closed:c.dealsClosed,
      new_upfront:Math.round(c.newUpfront), future_upfront:Math.round(c.futureUpfront),
      score:s, zone:zoneCloser(c,s), on_leave:leaveNames.has(c.name),
    });
  });

  const { count } = await upsertRows(rows);
  return { date, builders:Object.keys(builderMap).length, closers:Object.keys(closerMap).length, upserted:count };
}

// ── Handler ─────────────────────────────────────────────────────────────────
function shiftDate(dateStr, days){
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

export default async function handler(req, res){
  // Auth — Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"; manual calls may use ?secret=
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (CRON_SECRET && bearer !== CRON_SECRET && req.query.secret !== CRON_SECRET){
    return res.status(401).json({ error:"unauthorized" });
  }
  if (!SUPABASE_URL || !SERVICE_KEY){
    return res.status(500).json({ error:"Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env" });
  }

  const force = req.query.force === "1";

  // Build the list of dates to snapshot
  let dates = [];
  if (req.query.date){
    dates = [req.query.date];
  } else if (req.query.start && req.query.end){
    let d = req.query.start;
    while (d <= req.query.end){ dates.push(d); d = shiftDate(d, 1); }
  } else {
    const estToday = new Date().toLocaleDateString("en-CA", { timeZone:"America/New_York" });
    dates = [ shiftDate(estToday, -1) ]; // yesterday (EST)
  }

  const results = [];
  try {
    for (const date of dates){
      const dow = new Date(date + "T12:00:00Z").getUTCDay(); // 0 Sun, 6 Sat
      if ((dow === 0 || dow === 6) && !force){
        results.push({ date, skipped:"weekend" });
        continue;
      }
      results.push(await snapshotDay(date));
    }
    return res.status(200).json({ ok:true, results });
  } catch (e){
    return res.status(500).json({ ok:false, error:String(e?.message || e), results });
  }
}
