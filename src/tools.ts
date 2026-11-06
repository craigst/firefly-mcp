import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FireflyClient, TransactionGroup } from './client.js';
import { buildForecast, iso, round2, type LeaveSpan } from './forecast.js';

export interface ServerOpts {
  currentAccountId: string;
  paydayWeekday: number;
  defaultBuffer: number;
  leaveSpans: LeaveSpan[];
}

const json = (v: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
});

const daysAgo = (n: number): string => iso(new Date(Date.now() - n * 86_400_000));

function flatten(groups: TransactionGroup[], accountName?: string) {
  const out: {
    date: string; amount: number; type: string; description: string;
    category: string | null; bill_id: string | null;
    source: string | null; destination: string | null; budget: string | null;
  }[] = [];
  for (const g of groups) {
    for (const t of g.attributes.transactions ?? []) {
      if (accountName && (t.source_name ?? '') !== accountName) continue;
      out.push({
        date: (t.date ?? '').slice(0, 10),
        amount: Number(t.amount),
        type: t.type,
        description: (t.description ?? '').trim(),
        category: t.category_name ?? null,
        bill_id: t.bill_id ?? null,
        source: t.source_name ?? null,
        destination: t.destination_name ?? null,
        budget: t.budget_name ?? null,
      });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export function registerTools(server: McpServer, client: FireflyClient, opts: ServerOpts): void {
  server.registerTool(
    'firefly_health',
    {
      title: 'Firefly connection health',
      description: 'Connection check ONLY. Returns no account data, no balances and no transactions. If you want the money, call accounts_list / net_worth / transactions_search instead.',
      inputSchema: {},
    },
    async () => {
      const a = await client.about();
      return json({ ok: true, ...a });
    },
  );

  server.registerTool(
    'accounts_list',
    {
      title: 'List accounts and balances',
      description:
        'Every real account with its current balance — THIS is the tool for "how much money do I have". '
        'Each row carries an `owner`: "Craig" for the household accounts and "Dad" for his own '
        'account, which is tracked separately and excluded from net worth. Always name it as Dad\'s '
        'when you report it.',
      inputSchema: {
        active_only: z.boolean().optional().describe('Only active accounts (default true)'),
        types: z.array(z.string()).optional()
          .describe('Filter by type, e.g. ["asset","liability"]'),
      },
    },
    async ({ active_only, types }) => {
      const all = await client.realAccounts();
      const rows = all
        .filter((a) => (active_only === false ? true : a.attributes.active))
        .filter((a) => (types?.length ? types.includes(a.attributes.type) : true))
        .map((a) => {
          const nm = a.attributes.name;
          const isDad = /^dad\b/i.test(nm);
          return {
            id: a.id,
            name: nm,
            owner: isDad ? 'Dad' : 'Craig',
            note: isDad
              ? "Dad's own account - tracked separately, NOT part of Craig's net worth, not his money"
              : null,
            type: a.attributes.type,
            role: a.attributes.account_role ?? null,
            balance: Number(a.attributes.current_balance),
            currency: a.attributes.currency_code,
            in_net_worth: a.attributes.include_net_worth,
            active: a.attributes.active,
          };
        })
        .sort((a, b) => b.balance - a.balance);
      return json({ count: rows.length, accounts: rows });
    },
  );

  server.registerTool(
    'account_get',
    {
      title: 'Get one account',
      description: 'Full detail for a single account by id or exact name.',
      inputSchema: {
        id: z.string().optional().describe('Account id'),
        name: z.string().optional().describe('Exact account name (used when id is absent)'),
      },
    },
    async ({ id, name }) => {
      let acctId = id;
      if (!acctId) {
        if (!name) throw new Error('give either id or name');
        const found = (await client.realAccounts()).find(
          (a) => a.attributes.name.toLowerCase() === name.toLowerCase(),
        );
        if (!found) throw new Error(`no account named "${name}"`);
        acctId = found.id;
      }
      const a = await client.account(acctId);
      return json({
        id: a.id,
        name: a.attributes.name,
        type: a.attributes.type,
        balance: Number(a.attributes.current_balance),
        currency: a.attributes.currency_code,
        in_net_worth: a.attributes.include_net_worth,
        notes: a.attributes.notes ?? null,
      });
    },
  );

  server.registerTool(
    'net_worth',
    {
      title: 'Net worth',
      description:
        'Assets minus liabilities, counting only accounts flagged for net worth. ' +
        'Firefly\'s own "net worth" figure reports assets only, so this subtracts debts. '
        'Dad\'s account is excluded on purpose - it is tracked but is not Craig\'s money.',
      inputSchema: {},
    },
    async () => {
      const all = await client.realAccounts();
      const counted = all.filter((a) => a.attributes.active && a.attributes.include_net_worth);
      const assets = counted.filter((a) => a.attributes.type === 'asset');
      const debts = counted.filter((a) =>
        a.attributes.type === 'liability' || a.attributes.type === 'liabilities' ||
        a.attributes.type === 'creditcard');
      const sum = (xs: typeof counted) => round2(xs.reduce((t, a) => t + Number(a.attributes.current_balance), 0));
      const assetTotal = sum(assets);
      const debtTotal = sum(debts.map((d) => ({
        ...d,
        attributes: { ...d.attributes, current_balance: String(Math.abs(Number(d.attributes.current_balance))) },
      })) as typeof counted);
      return json({
        assets: assetTotal,
        debts: debtTotal,
        net_worth: round2(assetTotal - debtTotal),
        asset_accounts: assets.map((a) => ({ name: a.attributes.name, balance: Number(a.attributes.current_balance) })),
        debt_accounts: debts.map((a) => ({ name: a.attributes.name, balance: Number(a.attributes.current_balance) })),
      });
    },
  );

  server.registerTool(
    'transactions_search',
    {
      title: 'Search transactions',
      description:
        'Transaction history, newest first. Filter by account, date range, type, category, text and amount.',
      inputSchema: {
        account_id: z.string().optional().describe('Restrict to one account id'),
        start: z.string().optional().describe('YYYY-MM-DD (default: 30 days ago)'),
        end: z.string().optional().describe('YYYY-MM-DD (default: today)'),
        type: z.string().optional().describe('withdrawal | deposit | transfer'),
        category: z.string().optional().describe('Category name, case-insensitive'),
        contains: z.string().optional().describe('Substring of the description'),
        min_amount: z.number().optional().describe('Minimum absolute amount'),
        max_amount: z.number().optional().describe('Maximum absolute amount'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 100'),
      },
    },
    async (a) => {
      const start = a.start ?? daysAgo(30);
      const end = a.end ?? iso(new Date());
      const groups = await client.transactions({
        accountId: a.account_id,
        start,
        end,
        type: a.type,
        limit: a.limit ?? 100,
      });
      let rows = flatten(groups);
      if (a.category) {
        const c = a.category.toLowerCase();
        rows = rows.filter((r) => (r.category ?? '').toLowerCase() === c);
      }
      if (a.contains) {
        const c = a.contains.toLowerCase();
        rows = rows.filter((r) => r.description.toLowerCase().includes(c));
      }
      if (a.min_amount !== undefined) rows = rows.filter((r) => r.amount >= a.min_amount!);
      if (a.max_amount !== undefined) rows = rows.filter((r) => r.amount <= a.max_amount!);
      const total = round2(rows.reduce((t, r) => t + r.amount, 0));
      return json({ start, end, count: rows.length, total_value: total, transactions: rows });
    },
  );

  server.registerTool(
    'spending_by_category',
    {
      title: 'Spending by category',
      description: 'Totals per category for a period. Withdrawals only, largest first.',
      inputSchema: {
        start: z.string().optional().describe('YYYY-MM-DD (default: start of this month)'),
        end: z.string().optional().describe('YYYY-MM-DD (default: today)'),
        account_id: z.string().optional().describe('Restrict to one account id'),
      },
    },
    async (a) => {
      const now = new Date();
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const start = a.start ?? iso(first);
      const end = a.end ?? iso(now);
      const groups = await client.transactions({ accountId: a.account_id, start, end, limit: 500 });
      const rows = flatten(groups).filter((r) => r.type === 'withdrawal');
      const by = new Map<string, { total: number; count: number }>();
      for (const r of rows) {
        const k = r.category ?? 'Uncategorised';
        const cur = by.get(k) ?? { total: 0, count: 0 };
        by.set(k, { total: cur.total + r.amount, count: cur.count + 1 });
      }
      const categories = [...by.entries()]
        .map(([name, v]) => ({ category: name, total: round2(v.total), transactions: v.count }))
        .sort((x, y) => y.total - x.total);
      return json({
        start, end,
        total: round2(categories.reduce((t, c) => t + c.total, 0)),
        categories,
      });
    },
  );

  server.registerTool(
    'monthly_summary',
    {
      title: 'Monthly income and spending',
      description: 'Income, expenses and net per month for the last N months.',
      inputSchema: {
        months: z.number().int().min(1).max(24).optional().describe('Default 6'),
        currency: z.string().optional().describe('Default GBP'),
      },
    },
    async (a) => {
      const months = a.months ?? 6;
      const currency = a.currency ?? 'GBP';
      const out = [];
      const now = new Date();
      for (let i = months - 1; i >= 0; i--) {
        const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
        const sIso = iso(s);
        const eIso = iso(e > now ? now : e);
        const summary = await client.summaryBasic(sIso, eIso, currency);
        const pick = (key: string) => {
          const hit = Object.keys(summary ?? {}).find((k) => k.startsWith(key));
          return hit ? Number(summary[hit]?.monetary_value ?? 0) : 0;
        };
        const income = pick('earned-in');
        const expenses = pick('spent-in');
        out.push({ month: sIso.slice(0, 7), income: round2(income), expenses: round2(expenses), net: round2(income - expenses) });
      }
      return json({ months: out });
    },
  );

  server.registerTool(
    'bills_list',
    {
      title: 'Bills and subscriptions',
      description:
        'Every active recurring bill with its amount and next due date — useful for "what have I got coming up".',
      inputSchema: {},
    },
    async () => {
      const bills = await client.bills();
      const now = new Date();
      const rows = bills
        .filter((b) => b.attributes.active)
        .map((b) => {
          const amount = (Number(b.attributes.amount_min) + Number(b.attributes.amount_max)) / 2;
          return {
            id: b.id,
            name: b.attributes.name,
            amount: round2(amount),
            repeat: b.attributes.repeat_freq,
            last_seen: (b.attributes.date ?? '').slice(0, 10),
            notes: b.attributes.notes ?? null,
          };
        })
        .sort((x, y) => y.amount - x.amount);
      const monthly = round2(rows.reduce((t, r) => t + (r.repeat === 'yearly' ? r.amount / 12 : r.repeat === 'weekly' ? r.amount * 4.33 : r.amount), 0));
      return json({ now: iso(now), count: rows.length, approx_monthly_total: monthly, bills: rows });
    },
  );

  server.registerTool(
    'budget_status',
    {
      title: 'Budget status',
      description: 'Budgets and what has been spent against their limit this period.',
      inputSchema: {},
    },
    async () => {
      const now = new Date();
      const start = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
      const end = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
      const [budgets, limits] = await Promise.all([
        client.budgets(),
        client.budgetLimits(start, end),
      ]);
      const nameById = new Map<string, string>();
      for (const b of budgets as any[]) nameById.set(String(b.id), b.attributes?.name ?? String(b.id));
      const rows = (limits as any[]).map((l) => {
        const a = l.attributes ?? {};
        return {
          budget: nameById.get(String(a.budget_id)) ?? String(a.budget_id),
          limit: a.amount ? Number(a.amount) : null,
          spent: a.spent ? Number(Array.isArray(a.spent) ? a.spent[0]?.sum ?? 0 : a.spent) : null,
          period_start: a.start ? String(a.start).slice(0, 10) : start,
          period_end: a.end ? String(a.end).slice(0, 10) : end,
        };
      });
      return json({ start, end, budgets: rows });
    },
  );

  server.registerTool(
    'cashflow_forecast',
    {
      title: 'Cash-flow forecast to payday and beyond',
      description:
        'Projects the current account day by day: pay in every payday, every bill on its due date, ' +
        'average spending in between. Returns safe-to-spend now, the projected balance at each payday, ' +
        'and the lowest point ahead (shortfall risk). This is the tool for "can I afford X" and ' +
        '"will I make it to payday".',
      inputSchema: {
        horizon_weeks: z.number().int().min(1).max(26).optional().describe('Default 8'),
        buffer: z.number().optional().describe('Cash to keep untouched (default 0)'),
        account_id: z.string().optional().describe('Override the configured current account'),
        leave_spans: z.array(z.object({ start: z.string(), end: z.string() })).optional()
          .describe('Annual-leave periods (YYYY-MM-DD) — pay is lower in those weeks'),
      },
    },
    async (a) => {
      const res = await buildForecast(client, {
        currentAccountId: a.account_id ?? opts.currentAccountId,
        paydayWeekday: opts.paydayWeekday,
        horizonWeeks: a.horizon_weeks,
        buffer: a.buffer ?? opts.defaultBuffer,
        leaveSpans: a.leave_spans ?? opts.leaveSpans,
      });
      const lines = [
        `Safe to spend now: £${res.safe_to_spend.toFixed(2)} (${res.days_left} days to payday ${res.payday})`,
        `Expected pay: £${res.predicted_wage.toFixed(2)}`,
        `Lowest point ahead: £${res.lowest_balance.toFixed(2)} on ${res.lowest_date}` +
          (res.shortfall ? '  <-- SHORTFALL RISK' : ''),
      ];
      return { content: [{ type: 'text' as const, text: `${lines.join('\n')}\n\n${JSON.stringify(res, null, 2)}` }] };
    },
  );

  server.registerTool(
    'affordability_check',
    {
      title: 'Can I afford this?',
      description:
        'Answers whether a given purchase fits before the next payday without breaking upcoming bills. ' +
        'Considers the forecast low point, so a buy that is technically affordable today but causes a ' +
        'shortfall before a bill lands is reported as risky.',
      inputSchema: {
        amount: z.number().positive().describe('Purchase amount'),
        description: z.string().optional().describe('What it is, for the answer'),
      },
    },
    async (a) => {
      const f = await buildForecast(client, {
        currentAccountId: opts.currentAccountId,
        paydayWeekday: opts.paydayWeekday,
        horizonWeeks: 8,
        buffer: opts.defaultBuffer,
        leaveSpans: opts.leaveSpans,
      });
      const fitsNow = a.amount <= f.safe_to_spend;
      const lowAfter = round2(f.lowest_balance - a.amount);
      const safe = fitsNow && lowAfter >= 0;
      const reason = !fitsNow
        ? `£${a.amount.toFixed(2)} exceeds the £${f.safe_to_spend.toFixed(2)} free before payday (after £${f.committed.toFixed(2)} of bills still to leave)`
        : lowAfter < 0
          ? `affordable today, but it would take the balance to £${lowAfter.toFixed(2)} on ${f.lowest_date}, before the next pay lands`
          : `fits, and the balance still bottoms out at £${lowAfter.toFixed(2)} on ${f.lowest_date}`;
      return json({
        affordable: safe,
        verdict: safe ? 'yes' : 'risky',
        amount: a.amount,
        description: a.description ?? null,
        reason,
        safe_to_spend_today: f.safe_to_spend,
        projected_low_without_purchase: f.lowest_balance,
        projected_low_with_purchase: lowAfter,
        lowest_date: f.lowest_date,
        payday: f.payday,
        bills_before_payday: f.due_before_payday,
      });
    },
  );

  server.registerTool(
    'categories_list',
    {
      title: 'List categories',
      description: 'Every spending category, so filters can use exact names.',
      inputSchema: {},
    },
    async () => {
      const cats = await client.categories();
      return json({ count: cats.length, categories: cats.map((c) => c.attributes.name).sort() });
    },
  );
}
