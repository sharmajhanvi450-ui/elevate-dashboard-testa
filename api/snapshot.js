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
//   (none)                    re-read the trailing RESNAPSHOT_DAYS days:
//                             yesterday, then the rest oldest-first
//   ?days=N                   override the trailing window for one call
//
// Weekends are snapshotted too, but only for people who actually worked: deals
// do close on a Saturday, and a day of zero rows for everyone else would be read
// as a working day by anything counting rows.

export const config = { maxDuration: 60 };

// How far back a nightly run re-reads. Zoho entries get back-dated all the time
// — an upfront date corrected after the fact, a deal keyed in days later — and a
// snapshot taken once at 00:30 and never revisited keeps the stale figure for
// ever. August lost two closer deals exactly that way. Upserts are idempotent,
// so re-reading a settled day costs time, not correctness.
const RESNAPSHOT_DAYS = 7;

// Vercel kills the function at maxDuration and the whole response is lost with
// it, so stop starting new days near the ceiling. The window slides every night,
// so a day left undone here is picked up by the next run.
const TIME_BUDGET_MS = 45000;

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
// ── Zoho transport ──────────────────────────────────────────────────────────
// A limiter and a retry, matching api/_lib/report-core.js in the live repo.
// Without them a 429 or a 5xx came back as an empty page and the day was
// silently written short — and the adaptive call splitting below fans out far
// more requests than the old two-window read did, so the cap matters more now.
const COQL_OFFSET_CEILING = 2000;

function makeLimiter(max){
  let active = 0; const q = [];
  const pump = () => { while (active < max && q.length) { active++; (q.shift())(); } };
  return fn => new Promise((resolve, reject) => {
    q.push(() => fn().then(resolve, reject).finally(() => { active--; pump(); }));
    pump();
  });
}
const _limit = makeLimiter(8);

async function zohoFetch(url, opts){
  return _limit(async () => {
    for (let attempt = 0; ; attempt++){
      const r = await fetch(url, opts);
      if ((r.status === 429 || r.status >= 500) && attempt < 6){
        await new Promise(res => setTimeout(res,
          Math.min(800 * 2 ** attempt, 12000) + Math.floor(Math.random() * 300)));
        continue;
      }
      return r;
    }
  });
}

async function zohoGet(token, url){
  const r = await zohoFetch(url, { headers:{ Authorization:`Zoho-oauthtoken ${token}` } });
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
// Reports whether it hit the ceiling rather than returning a short list, so the
// caller can split the window instead of silently storing fewer calls.
async function coqlCallsWindow(token, startDT, endDT){
  const out = [];
  let offset = 0;
  let truncated = false;
  while (true){
    const q = `select Owner, Call_Duration_in_seconds, Call_Start_Time, Call_Type, Call_Status `
            + `from Calls where Call_Start_Time between '${startDT}' and '${endDT}' limit ${offset}, 200`;
    const r = await zohoFetch(`${API_DOMAIN}/crm/v2/coql`, {
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
    if (offset >= COQL_OFFSET_CEILING) { truncated = true; break; }
  }
  return { rows: out, truncated };
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

// All Calls on `date` (Eastern-time calendar day). Uses a COQL datetime range so
// any date works regardless of age.
//
// Two 12-hour windows was not enough. The Calls query carries no owner filter,
// so COQL's 2000-record ceiling applies to org-wide volume: on 21 August 2026
// the afternoon window held 3,002 calls and 1,002 were dropped without a word.
// Modelled across the month that cost roughly 5,600 calls, which is why every
// builder's August total read about 15% low against the CRM's own export.
//
// So each window now reports truncation and halves itself until it fits. Four
// 6-hour windows to start: cheap on a normal day, and each subdivides only if
// the volume warrants. Ported from api/_lib/report-core.js in the live repo,
// which fixed this in commit d47721b — this file never received it.
const MIN_SPAN_MS = 60 * 1000;

// `read` is a seam for the tests: they hand in a reader backed by a real day's
// export so the splitting can be exercised against actual volumes rather than
// against a guess about them. Production always uses the default.
async function readCallSpan(token, fromMs, toMs, depth = 0, read = coqlCallsWindow){
  const { rows, truncated } = await read(
    token, fmtCOQL(new Date(fromMs)), fmtCOQL(new Date(toMs)));
  if (!truncated) return rows;
  // Below a minute a split cannot help: more than 2000 calls inside one minute
  // would be the same records however the span is cut. Throwing beats returning
  // a short count that looks fine.
  if (toMs - fromMs <= MIN_SPAN_MS || depth > 12){
    throw new Error(
      `Calls window ${new Date(fromMs).toISOString()}..${new Date(toMs).toISOString()} `
      + `exceeds COQL's ${COQL_OFFSET_CEILING}-record limit and cannot be split further`);
  }
  const mid = fromMs + Math.floor((toMs - fromMs) / 2);
  const [a, b] = await Promise.all([
    readCallSpan(token, fromMs, mid, depth + 1, read),
    readCallSpan(token, mid + 1000, toMs, depth + 1, read),   // +1s so the halves cannot overlap
  ]);
  return a.concat(b);
}

async function fetchCallsForDay(token, date){
  const dayStart = nyMidnightUTC(date).getTime();
  const H6 = 6 * 60 * 60 * 1000;
  const parts = await Promise.all([0, 1, 2, 3].map(i =>
    readCallSpan(token, dayStart + i * H6, dayStart + (i + 1) * H6 - 1000)));
  return parts.flat();
}
// Records in a module whose `dateField` equals `date`.
//
// Read through COQL, not /search. Zoho's /search is index-backed and
// eventually-consistent, so it returns approximate results: measured against the
// CRM's own export for August 2026 it lost four to six presentations a day,
// about 26% of the month's total. funnel.js and bde.js were moved to COQL for
// exactly this reason; this file was not.
async function fetchByDay(token, module, fields, date, dateField){
  let all = [], offset = 0;
  while (true){
    const q = `select ${fields} from ${module} where ${dateField} = '${date}' limit ${offset}, 200`;
    const r = await zohoFetch(`${API_DOMAIN}/crm/v2/coql`, {
      method:"POST",
      headers:{ Authorization:`Zoho-oauthtoken ${token}`, "Content-Type":"application/json" },
      body: JSON.stringify({ select_query: q }),
    });
    if (r.status === 204) break;
    const data = await r.json();
    if (!data?.data?.length) break;
    all = all.concat(data.data);
    if (!data.info?.more_records) break;
    offset += 200;
    // A single day of one module going past 2000 would need the same time
    // splitting the Calls read has. Say so rather than storing a short count.
    if (offset >= COQL_OFFSET_CEILING){
      throw new Error(
        `${module}.${dateField} on ${date} exceeds COQL's ${COQL_OFFSET_CEILING}-record `
        + `limit; this fetch needs splitting by time like the Calls one`);
    }
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
const isWeekendDate = date => {
  const dow = new Date(date + "T12:00:00Z").getUTCDay();   // 0 Sun, 6 Sat
  return dow === 0 || dow === 6;
};

// Anything at all worth recording — used to pick which weekend rows to keep.
const hasActivity = r =>
  r.calls || r.minutes || r.leads || r.discoveries || r.pres_booked ||
  r.pres_completed || r.presentations || r.deals_closed ||
  r.new_upfront || r.future_upfront;

async function snapshotDay(date){
  const token = await getToken();

  // AllUsers, not ActiveUsers. Someone deactivated in Zoho still owns the calls
  // and deals they logged while they were here; ActiveUsers dropped them from the
  // id map, so their work vanished from the day entirely. The CRM export for
  // August lists 30 builders where this file had recorded 20. Same fix as the
  // live repo's commit f3bdf4d — the roster is filtered separately, further down.
  const ud = await zohoGet(token, `${API_DOMAIN}/crm/v2/users?type=AllUsers&per_page=200`);
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

  // On a weekend, keep only the people who actually worked. A full set of zero
  // rows would otherwise land in daily_kpi, and anything that measures a period
  // by the rows it finds would read Saturday as a working day — which is exactly
  // how the History page derives its targets.
  const keep = isWeekendDate(date) ? rows.filter(hasActivity) : rows;
  if (!keep.length) return { date, weekend:true, upserted:0, note:"nobody worked" };

  const { count } = await upsertRows(keep);
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

  // Build the list of dates to snapshot
  let dates = [];
  if (req.query.date){
    dates = [req.query.date];
  } else if (req.query.start && req.query.end){
    let d = req.query.start;
    while (d <= req.query.end){ dates.push(d); d = shiftDate(d, 1); }
  } else {
    // Nightly run: yesterday first — it is the day everyone looks at, and a run
    // that gets cut short must never miss it. Then the REST OLDEST FIRST.
    //
    // The order matters. Walking newest-to-oldest would mean a run that only has
    // time for three days re-reads the same three every night, and a correction
    // back-dated to last Tuesday is never picked up. Oldest-first, with the
    // window sliding one day each night, every date passes through the far end
    // exactly once — so each day is read when it is new and read again a week
    // later, whatever the time budget allows in between.
    const estToday = new Date().toLocaleDateString("en-CA", { timeZone:"America/New_York" });
    const span = Math.max(1, Math.min(31, parseInt(req.query.days, 10) || RESNAPSHOT_DAYS));
    dates.push(shiftDate(estToday, -1));
    for (let i = span; i >= 2; i--) dates.push(shiftDate(estToday, -i));
  }

  const startedAt = Date.now();
  const results = [];
  try {
    for (const date of dates){
      // Never abandon the first day — without it a run does nothing at all.
      if (results.length && Date.now() - startedAt > TIME_BUDGET_MS){
        results.push({ date, skipped:"out of time, next run will re-read it" });
        continue;
      }
      results.push(await snapshotDay(date));
    }
    return res.status(200).json({ ok:true, results });
  } catch (e){
    return res.status(500).json({ ok:false, error:String(e?.message || e), results });
  }
}
