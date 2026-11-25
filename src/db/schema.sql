CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT,
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  active        INTEGER NOT NULL DEFAULT 1,
  verified      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),  -- owner/creator
  name       TEXT    NOT NULL,
  color      TEXT,                                   -- '#RRGGBB' or NULL (client default)
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_teams_user ON teams(user_id);

CREATE TABLE IF NOT EXISTS team_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  role       TEXT    NOT NULL CHECK (role IN ('owner', 'member', 'guest')),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT,
  UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  issued_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT    NOT NULL,
  revoked_at TEXT,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  team_id    INTEGER REFERENCES teams(id),
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('income', 'expense', 'both')),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
CREATE INDEX IF NOT EXISTS idx_categories_team ON categories(team_id);

CREATE TABLE IF NOT EXISTS vaults (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  team_id       INTEGER REFERENCES teams(id),
  name          TEXT    NOT NULL,
  target_amount INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_vaults_user ON vaults(user_id);
CREATE INDEX IF NOT EXISTS idx_vaults_team ON vaults(team_id);

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  team_id     INTEGER REFERENCES teams(id),
  type        TEXT    NOT NULL CHECK (type IN ('income', 'expense')),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  category_id INTEGER REFERENCES categories(id),
  loan_id     INTEGER REFERENCES loans(id),  -- journal flag (ADR-010): set by lend/repay, excluded from balance
  description TEXT,
  occurred_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d', 'now')),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_user     ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_team     ON transactions(team_id);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_occurred ON transactions(team_id, occurred_at, id);

-- Append-only ledger of vault movements; source of truth for vault balances.
-- A vault's balance = SUM(allocate) - SUM(withdraw). Movements are not tied to a transaction.
CREATE TABLE IF NOT EXISTS vault_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  vault_id   INTEGER NOT NULL REFERENCES vaults(id),
  action     TEXT    NOT NULL CHECK (action IN ('allocate', 'withdraw')),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_vault_history_vault ON vault_history(vault_id);

-- Receivables: money lent out (ADR-010). Context-scoped like vaults. No money
-- columns: amount/pending derive from loan_history, like a vault balance.
CREATE TABLE IF NOT EXISTS loans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  team_id    INTEGER REFERENCES teams(id),
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_loans_user ON loans(user_id);
CREATE INDEX IF NOT EXISTS idx_loans_team ON loans(team_id);

-- Append-only ledger of loan movements; source of truth for loan figures.
-- pending = SUM(lend) - SUM(repay); amount lent = SUM(lend).
CREATE TABLE IF NOT EXISTS loan_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  loan_id    INTEGER NOT NULL REFERENCES loans(id),
  action     TEXT    NOT NULL CHECK (action IN ('lend', 'repay')),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_loan_history_loan ON loan_history(loan_id);

-- Pre-expense checklists. Context-scoped like transactions (team_id + ?team_id=).
-- Checkout books one expense transaction (transaction_id) and freezes status -> 'purchased'.
CREATE TABLE IF NOT EXISTS shopping_lists (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  team_id        INTEGER REFERENCES teams(id),          -- NULL = personal (standard context scoping)
  name           TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'purchased')),
  category_id    INTEGER REFERENCES categories(id),     -- default category for checkout (nullable)
  transaction_id INTEGER REFERENCES transactions(id),   -- set by checkout, else NULL
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_shopping_lists_user ON shopping_lists(user_id);
CREATE INDEX IF NOT EXISTS idx_shopping_lists_team ON shopping_lists(team_id);

-- Checklist rows. Flat, listed via ?list_id=; authorized through the parent list.
CREATE TABLE IF NOT EXISTS shopping_list_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  list_id    INTEGER NOT NULL REFERENCES shopping_lists(id),
  name       TEXT    NOT NULL,
  qty        REAL    NOT NULL DEFAULT 1,
  price      INTEGER,                                    -- cents (moneyFields); optional per-UNIT estimate
  checked    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shopping_list_items_list ON shopping_list_items(list_id);

-- Append-only activity ledger (ADR-009). Immutable: no updates, no soft deletes.
-- user_id is the ACTOR; team_id is the affected record's context (NULL = personal).
-- summary is a JSON display snapshot; amounts inside it are DECIMALS (client-ready).
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  team_id    INTEGER REFERENCES teams(id),
  entity     TEXT    NOT NULL,
  entity_id  INTEGER NOT NULL,
  action     TEXT    NOT NULL,
  summary    TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_events_team ON events(team_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
