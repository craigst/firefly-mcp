/** Minimal Firefly III API client. Read-only by design: this server never mutates. */

export interface FireflyConfig {
  baseUrl: string;
  token: string;
}

export class FireflyError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FireflyError';
  }
}

export interface Account {
  id: string;
  attributes: {
    name: string;
    type: string;
    active: boolean;
    current_balance: string;
    currency_code: string;
    include_net_worth: boolean;
    account_role?: string | null;
    iban?: string | null;
    notes?: string | null;
  };
}

export interface Bill {
  id: string;
  attributes: {
    name: string;
    active: boolean;
    amount_min: string;
    amount_max: string;
    date: string;
    repeat_freq: string;
    notes?: string | null;
    next_expected_match?: string | null;
  };
}

export interface TransactionLine {
  type: string;
  amount: string;
  description: string;
  date: string;
  bill_id?: string | null;
  category_name?: string | null;
  source_name?: string | null;
  destination_name?: string | null;
  budget_name?: string | null;
  tags?: string[];
}

export interface TransactionGroup {
  id: string;
  attributes: {
    group_title?: string | null;
    transactions: TransactionLine[];
  };
}

export class FireflyClient {
  private readonly base: string;

  constructor(private readonly cfg: FireflyConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, '');
  }

  async get<T = unknown>(path: string): Promise<T> {
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new FireflyError(`cannot reach Firefly at ${this.base}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new FireflyError(`Firefly ${res.status} on ${path}: ${body}`, res.status);
    }
    return (await res.json()) as T;
  }

  async about(): Promise<{ version: string; api_version: string }> {
    const j = await this.get<{ data: { version: string; api_version: string } }>('/api/v1/about');
    return j.data;
  }

  async accounts(type?: string): Promise<Account[]> {
    const q = new URLSearchParams();
    if (type) q.set('type', type);
    q.set('limit', '200');
    const j = await this.get<{ data: Account[] }>(`/api/v1/accounts?${q}`);
    return j.data;
  }

  /**
   * The accounts a person actually holds.
   *
   * A bare /accounts returns the first 200 rows and Firefly auto-creates an
   * expense account per merchant, so the real asset/liability accounts are
   * buried past page one. Ask for the types explicitly instead.
   */
  async realAccounts(): Promise<Account[]> {
    const out: Account[] = [];
    for (const t of ['asset', 'liabilities', 'cash']) {
      try {
        out.push(...(await this.accounts(t)));
      } catch {
        /* a type with no rows is not an error */
      }
    }
    return out;
  }

  async account(id: string): Promise<Account> {
    const j = await this.get<{ data: Account }>(`/api/v1/accounts/${id}`);
    return j.data;
  }

  async transactions(opts: {
    accountId?: string;
    start?: string;
    end?: string;
    type?: string;
    limit?: number;
    page?: number;
  }): Promise<TransactionGroup[]> {
    const q = new URLSearchParams();
    if (opts.start) q.set('start', opts.start);
    if (opts.end) q.set('end', opts.end);
    if (opts.type) q.set('type', opts.type);
    q.set('limit', String(opts.limit ?? 100));
    q.set('page', String(opts.page ?? 1));
    const path = opts.accountId
      ? `/api/v1/accounts/${opts.accountId}/transactions?${q}`
      : `/api/v1/transactions?${q}`;
    const j = await this.get<{ data: TransactionGroup[] }>(path);
    return j.data;
  }

  async bills(): Promise<Bill[]> {
    const j = await this.get<{ data: Bill[] }>('/api/v1/bills?limit=100');
    return j.data;
  }

  async billTransactions(billId: string, limit = 5): Promise<TransactionGroup[]> {
    const j = await this.get<{ data: TransactionGroup[] }>(
      `/api/v1/bills/${billId}/transactions?limit=${limit}`,
    );
    return j.data;
  }

  async categories(): Promise<{ id: string; attributes: { name: string } }[]> {
    const j = await this.get<{ data: { id: string; attributes: { name: string } }[] }>(
      '/api/v1/categories?limit=200',
    );
    return j.data;
  }

  async budgets(): Promise<unknown[]> {
    const j = await this.get<{ data: unknown[] }>('/api/v1/budgets?limit=100');
    return j.data;
  }

  async budgetLimits(start: string, end: string): Promise<unknown[]> {
    const j = await this.get<{ data: unknown[] }>(
      `/api/v1/budget-limits?start=${start}&end=${end}&limit=200`,
    );
    return j.data;
  }

  async summaryBasic(start: string, end: string, currency = 'GBP'): Promise<any> {
    const j = await this.get<{ data: any }>(
      `/api/v1/summary/basic/${start}/${end}?currency_code=${currency}`,
    );
    return j.data;
  }

  async insightExpenseByCategory(start: string, end: string): Promise<unknown[]> {
    const j = await this.get<{ data: unknown[] }>(
      `/api/v1/insight/expense/category?start=${start}&end=${end}&limit=100`,
    );
    return j.data;
  }
}
