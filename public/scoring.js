// Shared scoring — single source of truth for targets, weights, zones and the
// per-person overrides that sit on top of them.
//
// This exists because the same scoring logic had been copy-pasted into
// index.html, combined.html, history.html and tv-board.html, and the copies
// drifted: history.html required 4 deals for Gold where every other page
// required 2, tv-board.html ignored per-closer overrides entirely and had no
// weekend check in its day-fraction, and combined.html's resolveOverride was
// missing the legacy no-month fallback the other four had. Same person, same
// period, different score depending on which page you opened.
//
// Everything is exposed on one `Scoring` global rather than as loose functions,
// so a page that loads this file cannot accidentally shadow or be shadowed by
// its own local helper of the same name.
const Scoring = (() => {
  "use strict";

  // Built-in daily targets and weights. Weights are fractions summing to 1.
  const TARGETS = {
    Builder: { calls: 150, minutes: 180, leads: 4, discoveries: 2, presBooked: 2, presCompleted: 2 },
    Closer:  { calls: 60,  minutes: 120, presentations: 2 },
  };
  const WEIGHTS = {
    Builder: { calls: 0.20, minutes: 0.20, leads: 0.10, discoveries: 0.15, presBooked: 0.10, presCompleted: 0.25 },
    Closer:  { calls: 0.40, minutes: 0.20, presentations: 0.40 },
  };

  // Basis for turning a stored monthly target into a daily rate. Kept as a
  // fixed 22 rather than the month's real weekday count because that is what
  // the app has always used; manage-targets.html surfaces the resulting gap
  // instead of quietly changing everyone's numbers.
  const WORKING_DAYS_PER_MONTH = 22;

  // Raw deal counts, never divided by working days.
  const DEAL_DEFAULTS = { gold: 2, green: 1 };
  // Ranges at or under this many days always use DEAL_DEFAULTS: requiring a
  // whole month's deal count inside a single day makes no sense.
  const DAILY_RANGE_MAX_DAYS = 7;

  // Weightage rows live in kpi_target_overrides under a prefixed label, so they
  // can never be read as a KPI target of the same name.
  const W_PREFIX = "w:";

  const WORK_START_H = 10.5;   // 10:30 AM ET
  const WORK_END_H   = 19.5;   // 7:30 PM ET
  const WORK_HOURS   = WORK_END_H - WORK_START_H;

  // ── Overrides ──────────────────────────────────────────────────────────────
  // Exact month first, then a legacy row saved before targets were per-month.
  // Both branches matter: dropping the fallback is what made combined.html
  // disagree with index.html for anyone whose override predates per-month rows.
  function resolveOverride(rows, personKey, kpiLabel, month) {
    if (!rows || !rows.length) return null;
    const exact = rows.find(r => r.person_key === personKey && r.kpi_label === kpiLabel && r.month === month);
    if (exact) return exact.monthly_target;
    const legacy = rows.find(r => r.person_key === personKey && r.kpi_label === kpiLabel && !r.month);
    return legacy ? legacy.monthly_target : null;
  }

  // Per-person daily targets: a stored monthly override becomes a daily rate,
  // otherwise the built-in daily target stands. Multiplied by the number of
  // working days actually in view.
  //
  // Leave is deliberately not deducted — the target covers every working day in
  // the period whether the person was in or not.
  function personTargets(rows, personKey, baseDailyRates, month, effectiveDays) {
    return Object.fromEntries(Object.entries(baseDailyRates).map(([k, v]) => {
      const resolved = resolveOverride(rows, personKey, k, month);
      const dailyRate = resolved != null ? resolved / WORKING_DAYS_PER_MONTH : v;
      return [k, Math.max(1, Math.round(dailyRate * effectiveDays))];
    }));
  }

  // Same as personTargets, but the caller names the ROLE rather than handing
  // over a base object. That hand-over is what went wrong on two pages: both
  // index.html and combined.html build `T = TARGETS x effectiveDays` for their
  // display columns and then passed that same object back in here, so the period
  // multiplier landed twice and every KPI without a per-person override got a
  // target effectiveDays^2 too large. Naming the role removes the chance.
  function personTargetsFor(rows, personKey, role, month, effectiveDays) {
    const base = TARGETS[role];
    if (!base) throw new Error(`Scoring.personTargetsFor: unknown role "${role}"`);
    return personTargets(rows, personKey, base, month, effectiveDays);
  }

  // Per-person weights, as fractions. Stored values are whole percentages, and
  // each KPI falls back to its role default independently, so a partially
  // configured person still scores.
  //
  // The sum is honoured as configured rather than normalised: normalising would
  // mean the number someone typed on the manage page is not the number that
  // applies. Use weightSum() to show when it is off.
  function personWeights(rows, personKey, role, month) {
    const base = WEIGHTS[role];
    if (!base) throw new Error(`Scoring.personWeights: unknown role "${role}"`);
    return Object.fromEntries(Object.entries(base).map(([k, v]) => {
      const pct = resolveOverride(rows, personKey, W_PREFIX + k, month);
      return [k, pct != null ? pct / 100 : v];
    }));
  }
  const weightSum = weights => Object.values(weights).reduce((s, w) => s + w, 0);

  // Per-closer Gold/Green deal thresholds. Short ranges always use the fixed
  // rule; only longer ranges apply a team lead's monthly override.
  function dealThresholds(rows, personKey, month, rangeDays) {
    if (rangeDays <= DAILY_RANGE_MAX_DAYS) return { ...DEAL_DEFAULTS };
    const gold  = resolveOverride(rows, personKey, "goldDeals", month);
    const green = resolveOverride(rows, personKey, "greenDeals", month);
    return {
      gold:  gold  != null ? gold  : DEAL_DEFAULTS.gold,
      green: green != null ? green : DEAL_DEFAULTS.green,
    };
  }

  // ── Scores ─────────────────────────────────────────────────────────────────
  const cap = (v, tgt) => Math.min(150, tgt > 0 ? (v / tgt) * 100 : 0);

  function kpiScore(person, targets, weights) {
    let total = 0;
    for (const k in weights) total += cap(person[k] || 0, targets[k]) * weights[k];
    return total;
  }

  function builder(b, targets, weights) {
    return Math.round(kpiScore(b, targets, weights || WEIGHTS.Builder));
  }

  // Deals act as a multiplier with a floor and a ceiling, rather than as another
  // weighted KPI: below the Green count the score is KPI-only and capped at 110,
  // Green lifts it x1.25 (floor 95, cap 125), Gold x1.50 (floor 110, cap 150).
  function closer(c, targets, deals, weights) {
    const g = deals || DEAL_DEFAULTS;
    const kpi = kpiScore(c, targets, weights || WEIGHTS.Closer);
    // A threshold of 0 would make `>=` true for everyone, handing out the Gold
    // multiplier unconditionally, so treat it as "no threshold set".
    const gold  = g.gold  > 0 ? g.gold  : DEAL_DEFAULTS.gold;
    const green = g.green > 0 ? g.green : DEAL_DEFAULTS.green;
    if ((c.dealsClosed || 0) >= gold)  return Math.round(Math.min(Math.max(kpi * 1.50, 110), 150));
    if ((c.dealsClosed || 0) >= green) return Math.round(Math.min(Math.max(kpi * 1.25, 95), 125));
    return Math.round(Math.min(kpi, 110));
  }

  const zone = s => s >= 110 ? "gold" : s >= 95 ? "green" : s >= 75 ? "yellow" : s >= 50 ? "orange" : "red";
  // A closer with no calls and no deals is Red regardless of what the weighted
  // KPIs come to, so an empty day cannot read as a good one.
  const zoneCloser = (c, s) => (!c.calls && !c.dealsClosed) ? "red" : zone(s);

  // ── Day fractions ──────────────────────────────────────────────────────────
  // Weekends carry no target. Missing this is why tv-board.html showed prorated
  // targets and live scores on a Saturday.
  const isWeekend = dateStr => {
    const dow = new Date(dateStr + "T12:00:00Z").getUTCDay();
    return dow === 0 || dow === 6;
  };
  const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // Fraction of the working day elapsed on `dateStr`, in ET.
  //   fullDay: treat today as complete (the dashboard's Full Day toggle)
  function dayFraction(dateStr, { fullDay = false } = {}) {
    if (isWeekend(dateStr)) return 0;
    if (fullDay) return 1;
    const today = todayET();
    if (dateStr !== today) return 1;              // any other weekday is complete
    const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const h = nowET.getHours() + nowET.getMinutes() / 60;
    if (h <= WORK_START_H) return 0.01;           // before work — near zero, never 0
    if (h >= WORK_END_H)   return 1;
    return (h - WORK_START_H) / WORK_HOURS;
  }

  // Working days in view across a range. Weekends contribute 0.
  function totalDayFraction(startDate, endDate, opts) {
    let total = 0;
    const d = new Date(startDate + "T12:00:00Z");
    const e = new Date(endDate + "T12:00:00Z");
    while (d <= e) {
      total += dayFraction(d.toISOString().split("T")[0], opts);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return total;
  }

  // A report range can straddle a month boundary, but overrides are stored per
  // month, so one month has to win. The month holding the most WORKING days
  // takes it: a target is a daily rate times working days, so that is the month
  // most of the target actually comes from.
  //
  // It used to be simply the month the range started in. For 31 Aug - 6 Sep that
  // chose August off the back of one working day while the other four were
  // September's — so targets set for September were not the ones being applied,
  // which is exactly what it looked like from the outside.
  //
  // A tie goes to the earlier month, and a range with no working days at all
  // (a weekend) falls back to calendar days so it still resolves to something.
  function dominantMonth(startDate, endDate) {
    const work = {}, all = {};
    const d = new Date(startDate + "T12:00:00Z");
    const end = new Date(endDate + "T12:00:00Z");
    while (d <= end) {
      const iso = d.toISOString().slice(0, 10);
      const m = iso.slice(0, 7);
      all[m] = (all[m] || 0) + 1;
      if (!isWeekend(iso)) work[m] = (work[m] || 0) + 1;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const counts = Object.keys(work).length ? work : all;
    const winner = Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))[0];
    return winner || String(startDate).slice(0, 7);
  }

  // Inclusive day count, used to pick the daily-vs-monthly deal rule. Both ends
  // are anchored at noon UTC so a DST change cannot shift the count.
  function rangeDays(startDate, endDate) {
    const ms = new Date(endDate + "T12:00:00Z") - new Date(startDate + "T12:00:00Z");
    return Math.round(ms / 86400000) + 1;
  }

  return {
    TARGETS, WEIGHTS, WORKING_DAYS_PER_MONTH, DEAL_DEFAULTS, DAILY_RANGE_MAX_DAYS, W_PREFIX,
    WORK_START_H, WORK_END_H, WORK_HOURS,
    resolveOverride, personTargets, personTargetsFor, personWeights, weightSum, dealThresholds,
    builder, closer, zone, zoneCloser,
    dayFraction, totalDayFraction, rangeDays, isWeekend, todayET, dominantMonth,
  };
})();
