/**
 * Cash-flow forecast over the current account.
 *
 * Mirrors the logic proven in the HA script: wage in every payday, every bill on
 * its due date, average discretionary spending in between, projected day by day.
 *
 * Two traps that were found the hard way and are handled here:
 *  - Firefly returns transaction amounts as POSITIVE with direction in `type`.
 *  - `bill_id` lives on the TRANSACTION, not on the group.
 */
import type { FireflyClient, Bill, TransactionGroup } from './client.js';

const DAY = 86_400_000;

export const iso = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY);
const atUtc = (s: string): Date => new Date(`${s.slice(0, 10)}T00:00:00Z`);

export function stepDate(d: Date, freq: string | undefined): Date {
  const f = (freq ?? 'monthly').toLowerCase();
  if (f === 'weekly') return addDays(d, 7);
  if (f === 'monthly') {
    const m = d.getUTCMonth() + 1;
    const y = d.getUTCFullYear() + Math.floor(m / 12);
    const mm = m % 12;
    const day = Math.min(d.getUTCDate(), 28);
    return new Date(Date.UTC(y, mm, day));
  }
  if (f === 'quarterly') {
    const m = d.getUTCMonth() + 3;
    const y = d.getUTCFullYear() + Math.floor(m / 12);
    return new Date(Date.UTC(y, m % 12, Math.min(d.getUTCDate(), 28)));
  }
  if (f === 'half-year') {
    const m = d.getUTCMonth() + 6;
    const y = d.getUTCFullYear() + Math.floor(m / 12);
    return new Date(Date.UTC(y, m % 12, Math.min(d.getUTCDate(), 28)));
  }
  if (f === 'yearly') {
    return new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), Math.min(d.getUTCDate(), 28)));
  }
  return addDays(d, 3650);
}

export function nextDue(bill: Bill, today: Date): Date {
  let d = atUtc(bill.attributes.date);
  for (let i = 0; i < 400 && d < today; i++) d = stepDate(d, bill.attributes.repeat_freq);
  return d;
}

// --- payroll model, derived from 19 payslips (see README) -----------------
// shift £190 taxable; night £30 is an ALLOWANCE - not taxed, no NI, no pension.
export const SHIFT_RATE = 190.0;
export const NIGHT_RATE = 30.0;
const TAX_ALLOWANCE_WEEKLY = 241.73;   // 1257L
const NI_THRESHOLD_WEEKLY = 242.0;
const PENSION_FLOOR = 30.0;
const TAX_RATE = 0.2;
const NI_RATE = 0.08;
const PENSION_RATE = 0.04;

export interface PayWeek {
  shifts: number;
  nights: number;
  basic: number;
  night_pay: number;
  gross: number;
  tax: number;
  ni: number;
  pension: number;
  net: number;
  on_leave: boolean;
}

export interface RotaConfig {
  anchor: Date;       // first day of a 4-day run, phase-calibrated
  cycleDays: number;  // 8
  onDays: number;     // 4
  leaveShiftsCap: number;
}

export function onShift(d: Date, rota: RotaConfig): boolean {
  const days = Math.round((d.getTime() - rota.anchor.getTime()) / DAY);
  const m = ((days % rota.cycleDays) + rota.cycleDays) % rota.cycleDays;
  return m < rota.onDays;
}

export function shiftsBetween(start: Date, end: Date, rota: RotaConfig): number {
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) if (onShift(d, rota)) n += 1;
  return n;
}

export function payForWeek(payday: Date, onLeave: boolean, rota: RotaConfig): PayWeek {
  let shifts = shiftsBetween(addDays(payday, -6), payday, rota);
  let nights: number;
  if (onLeave) {
    shifts = Math.min(shifts, rota.leaveShiftsCap);
    nights = 0;                       // no night-out money on annual leave
  } else {
    nights = Math.max(0, shifts - 1);
  }
  const basic = SHIFT_RATE * shifts;
  const tax = TAX_RATE * Math.max(0, basic - TAX_ALLOWANCE_WEEKLY);
  const ni = NI_RATE * Math.max(0, basic - NI_THRESHOLD_WEEKLY);
  const pension = PENSION_RATE * Math.max(0, basic - PENSION_FLOOR);
  const nightPay = NIGHT_RATE * nights;
  return {
    shifts, nights,
    basic: round2(basic), night_pay: round2(nightPay), gross: round2(basic + nightPay),
    tax: round2(tax), ni: round2(ni), pension: round2(pension),
    net: round2(basic - tax - ni - pension + nightPay),
    on_leave: onLeave,
  };
}

export interface LeaveSpan { start: string; end: string; }

export interface ForecastOptions {
  currentAccountId: string;
  paydayWeekday: number;   // 0=Sun .. 4=Fri
  horizonWeeks?: number;
  buffer?: number;
  leaveSpans?: LeaveSpan[];
  currency?: string;
  rotaAnchor?: string;   // YYYY-MM-DD, phase-calibrated first shift day
  rotaCycleDays?: number;
  rotaOnDays?: number;
}

export interface DueItem { name: string; amount: number; due: string; }

export interface ForecastResult {
  today: string;
  payday: string;
  days_left: number;
  balance: number;
  committed: number;
  buffer: number;
  safe_to_spend: number;
  predicted_wage: number;
  predicted_gross: number;
  predicted_shifts: number;
  predicted_nights: number;
  predicted_tax: number;
  predicted_ni: number;
  predicted_pension: number;
  shift_rate: number;
  night_rate: number;
  normal_wage: number;
  leave_wage: number;
  on_leave: boolean;
  predicted_wage_high: number;
  predicted_weekly_spend: number;
  weeks_measured: number;
  projected_at_payday: number;
  lowest_balance: number;
  lowest_date: string;
  shortfall: boolean;
  weeks: { payday: string; balance: number; shifts: number; nights: number; gross: number; net: number; on_leave: boolean }[];
  due_before_payday: DueItem[];
  coming_after: DueItem[];
  assumptions: string[];
}

/** Best realistic week in the horizon (most shifts), for the upside figure. */
function weeklyHigh(rota: RotaConfig, payday: Date): number {
  let best = 0;
  for (let i = 0; i < 8; i++) {
    const d = addDays(payday, i * 7);
    const pw = payForWeek(d, false, rota);
    if (pw.net > best) best = pw.net;
  }
  return best;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function buildForecast(
  client: FireflyClient,
  opts: ForecastOptions,
): Promise<ForecastResult> {
  const horizonWeeks = opts.horizonWeeks ?? 8;
  const buffer = opts.buffer ?? 0;
  const leaveSpans = opts.leaveSpans ?? [];
  const now = new Date();
  const today = atUtc(iso(now));

  // paydayWeekday is Python-style (0=Monday, 4=Friday); JS getUTCDay() is
  // 0=Sunday, so it MUST be converted or Friday resolves to Thursday.
  const jsTarget = (opts.paydayWeekday + 1) % 7;
  let ahead = (jsTarget - today.getUTCDay() + 7) % 7;
  if (ahead === 0) ahead = 7;
  const payday = addDays(today, ahead);
  const daysLeft = ahead;

  const acc = await client.account(opts.currentAccountId);
  const balance = Number(acc.attributes.current_balance);

  // Only bills paid from THIS account affect its balance. Card-side bills reach
  // it through the single card-payment bill, so counting both double-counts.
  const allBills = (await client.bills()).filter((b) => b.attributes.active);
  const bills: Bill[] = [];
  for (const b of allBills) {
    const groups = await client.billTransactions(b.id, 5);
    if (groups.length === 0) { bills.push(b); continue; }
    const hits = groups.some((g) =>
      (g.attributes.transactions ?? []).some((t) =>
        (t.source_name ?? '') === acc.attributes.name,
      ),
    );
    if (hits) bills.push(b);
  }

  const horizonEnd = addDays(today, horizonWeeks * 7);
  const upcoming: { date: Date; name: string; amount: number }[] = [];
  for (const b of bills) {
    const amount =
      (Number(b.attributes.amount_min) + Number(b.attributes.amount_max)) / 2;
    let d = nextDue(b, today);
    for (let i = 0; i < 80 && d <= horizonEnd; i++) {
      upcoming.push({ date: d, name: b.attributes.name, amount });
      d = stepDate(d, b.attributes.repeat_freq);
    }
  }
  upcoming.sort((a, b) => a.date.getTime() - b.date.getTime());

  // --- rota + payroll model ------------------------------------------------
  // Live wages are no longer averaged: the 4-on/4-off rota tells us the shifts in
  // each pay week, and the payslip rates turn that into an exact gross and net.
  const rota: RotaConfig = {
    anchor: atUtc(opts.rotaAnchor ?? '2026-03-17'),
    cycleDays: opts.rotaCycleDays ?? 8,
    onDays: opts.rotaOnDays ?? 4,
    leaveShiftsCap: 3,
  };

  const overlapsLeave = (wkEnd: Date): boolean => {
    const wkStart = addDays(wkEnd, -6);
    return leaveSpans.some((sp) => {
      const s0 = atUtc(sp.start);
      const e0 = atUtc(sp.end);
      return s0 <= wkEnd && e0 >= wkStart;
    });
  };

  const onLeave = overlapsLeave(payday);
  const payThisWeek = payForWeek(payday, onLeave, rota);
  const weekPay = (d: Date): PayWeek => payForWeek(d, overlapsLeave(d), rota);

  // --- discretionary: mean of COMPLETE calendar weeks ----------------------
  const discTxns = await client.transactions({
    accountId: opts.currentAccountId,
    start: iso(addDays(today, -90)),
    end: iso(today),
    limit: 500,
  });
  const buckets = new Map<string, number>();
  for (const g of discTxns) {
    for (const t of g.attributes.transactions ?? []) {
      if (t.type !== 'withdrawal') continue;
      if (t.bill_id) continue;
      const d = atUtc((t.date ?? iso(today)).slice(0, 10));
      const monday = addDays(d, -((d.getUTCDay() + 6) % 7));
      const k = iso(monday);
      buckets.set(k, (buckets.get(k) ?? 0) + Math.abs(Number(t.amount)));
    }
  }
  const thisMonday = iso(addDays(today, -((today.getUTCDay() + 6) % 7)));
  const complete = [...buckets.entries()].filter(([k]) => k < thisMonday).map(([, v]) => v);
  const weeklySpend = complete.length
    ? mean(complete)
    : mean([...buckets.values()]);
  const dailySpend = weeklySpend / 7;

  // --- day-by-day projection ----------------------------------------------
  const dueByDay = new Map<string, number>();
  for (const u of upcoming) {
    const k = iso(u.date);
    dueByDay.set(k, (dueByDay.get(k) ?? 0) + u.amount);
  }

  let bal = balance;
  let lowest = balance;
  let lowestDay = today;
  const curve = new Map<string, number>();
  let nextFri = payday;
  for (let d = today; d <= horizonEnd; d = addDays(d, 1)) {
    if (d.getTime() === nextFri.getTime()) {
      bal += weekPay(nextFri).net;
      nextFri = addDays(nextFri, 7);
    }
    bal -= dueByDay.get(iso(d)) ?? 0;
    bal -= dailySpend;
    if (bal < lowest) { lowest = bal; lowestDay = d; }
    curve.set(iso(d), bal);
  }

  const weeks: {
    payday: string; balance: number; shifts: number; nights: number;
    gross: number; net: number; on_leave: boolean;
  }[] = [];
  for (let fri = payday; fri <= horizonEnd; fri = addDays(fri, 7)) {
    const b = curve.get(iso(fri));
    if (b === undefined) continue;
    const pw = weekPay(fri);
    weeks.push({
      payday: iso(fri), balance: round2(b), shifts: pw.shifts, nights: pw.nights,
      gross: pw.gross, net: pw.net, on_leave: pw.on_leave,
    });
  }

  const dueNow = upcoming.filter((u) => u.date <= payday);
  const committed = dueNow.reduce((a, b) => a + b.amount, 0);
  const safe = balance - committed - buffer;
  const afterPayday = addDays(payday, 14);

  const assumptions = [
    `income modelled from the rota: ${SHIFT_RATE}/shift + ${NIGHT_RATE}/night, ${payThisWeek.shifts} shifts and ${payThisWeek.nights} nights this week`,
    `discretionary assumed ${round2(weeklySpend)} per week (mean of ${complete.length} complete weeks, bills excluded)`,
    `bills limited to those paid from account "${acc.attributes.name}"`,
  ];
  if (onLeave) assumptions.push('payday week overlaps annual leave: holiday pay at basic only, no night-out money');

  return {
    today: iso(today),
    payday: iso(payday),
    days_left: daysLeft,
    balance: round2(balance),
    committed: round2(committed),
    buffer,
    safe_to_spend: round2(safe),
    predicted_wage: payThisWeek.net,
    predicted_gross: payThisWeek.gross,
    predicted_shifts: payThisWeek.shifts,
    predicted_nights: payThisWeek.nights,
    predicted_tax: payThisWeek.tax,
    predicted_ni: payThisWeek.ni,
    predicted_pension: payThisWeek.pension,
    shift_rate: SHIFT_RATE,
    night_rate: NIGHT_RATE,
    normal_wage: payThisWeek.net,
    leave_wage: round2(payForWeek(payday, true, rota).net),
    on_leave: onLeave,
    predicted_wage_high: round2(weeklyHigh(rota, payday)),
    predicted_weekly_spend: round2(weeklySpend),
    weeks_measured: complete.length,
    projected_at_payday: weeks.length ? weeks[0].balance : round2(balance),
    lowest_balance: round2(lowest),
    lowest_date: iso(lowestDay),
    shortfall: lowest < buffer,
    weeks,
    due_before_payday: dueNow.map((u) => ({
      name: u.name, amount: round2(u.amount), due: iso(u.date),
    })),
    coming_after: upcoming
      .filter((u) => u.date > payday && u.date <= afterPayday)
      .map((u) => ({ name: u.name, amount: round2(u.amount), due: iso(u.date) })),
    assumptions,
  };
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;
