# firefly-mcp

An MCP server over a **Firefly III** personal-finance database: balances,
transaction history, spending analysis, bills, budgets — and a **cash-flow
forecast** that answers "can I afford this?" and "will I make it to payday?".

Read-only by design. It never writes to Firefly.

## Tools

| Tool | What it answers |
|---|---|
| `accounts_list` | every account and its current balance |
| `account_get` | one account by id or exact name |
| `net_worth` | assets − liabilities (Firefly's own figure ignores debts) |
| `transactions_search` | history filtered by account, date, type, category, text, amount |
| `spending_by_category` | totals per category for a period |
| `monthly_summary` | income / expenses / net per month |
| `bills_list` | active recurring bills with amount and cadence |
| `budget_status` | budget limits and spend this period |
| `cashflow_forecast` | day-by-day projection: safe-to-spend, payday balances, lowest point |
| `affordability_check` | "can I afford £X?" including whether it causes a shortfall |
| `categories_list` | category names for filtering |
| `firefly_health` | connection and version check |

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `FIREFLY_BASE_URL` | `http://10.10.254.13:8090` | Firefly root, no `/api` |
| `FIREFLY_TOKEN` | *(required)* | personal access token |
| `FIREFLY_CURRENT_ACCOUNT_ID` | `1` | the account the forecast projects |
| `FIREFLY_PAYDAY_WEEKDAY` | `4` | **0 = Monday** … 4 = Friday |
| `FIREFLY_BUFFER` | `0` | cash to keep untouched |
| `FIREFLY_HOLIDAYS_JSON` | — | `{"spans":[{"start":"2026-11-09","end":"2026-11-13"}]}` |

## How the forecast works

Projects the current account **day by day**: income on every payday, every active
bill on its real due date, and average discretionary spending in between.

- **Income** = mean of the last 13 `WAGES` deposits (a flat weekly median is wrong
  for rota pay; leave weeks use the lowest observed instead).
- **Discretionary** = mean of complete calendar weeks of withdrawals that have no
  `bill_id`. The *mean* reconciles with the statements; the median does not, because
  spending arrives in bursts.
- **Bills** are limited to those actually paid from the projected account — card-side
  bills reach it through the card payment, so counting both double-counts.

## Two traps worth knowing if you fork this

1. Firefly returns transaction `amount` as a **positive** value; direction is in
   `type` (`withdrawal`/`deposit`). Summing on the sign yields zero.
2. `bill_id` is on the **transaction**, not the transaction group.

## Security

The server holds a personal access token and can read the whole ledger. Grant it
only to agents that should see it, and keep the token in the gateway's encrypted
config profile rather than an env file.

## Run

```bash
npm run setup                 # install + build
node dist/index.js --check    # validate config, no transport
node dist/index.js            # stdio (gateway / harness)
```

## Pay model (derived from 19 payslips)

| Component | Rate | Taxable? |
|---|---|---|
| Shift | £190.00 | yes |
| Night out | £30.00 | **no** — allowance, no NI, no pension |

```
basic   = 190 x shifts
PAYE    = 20%   x max(0, basic - 241.73)   # 1257L weekly
NI      = 8%    x max(0, basic - 242.00)   # employee threshold
pension = 4%    x max(0, basic - 30.00)    # Ee Pension
net     = basic - PAYE - NI - pension + 30 x nights
```

Verified against the slips: 4 shifts + 3 nights → £675.71 modelled vs £675.76 actual.
Tax and NI are charged on **basic only** — the night-out money is untaxed, which is
why a flat weekly average never predicted a week correctly.

**Rota**: 4 on / 4 off on an 8-day cycle. The calendar's event starts 2026-03-14,
but calibrated against 13 weeks of bank credits the pay-week phase sits 3 days
later, so the anchor is **2026-03-17**: 8 of 13 weeks then match within £2, and the
rest are one extra/fewer night or a fifth (overtime) shift.

**Annual leave**: no night-out money at all, and holiday pay behaves like basic only.
