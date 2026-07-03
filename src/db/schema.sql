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
  user_agent TEXT,
  name       TEXT,                                   -- automation tokens: user-given label
  scope      TEXT                                    -- NULL = full session; 'ingest' = POST /captures only
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
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  team_id           INTEGER REFERENCES teams(id),
  type              TEXT    NOT NULL CHECK (type IN ('income', 'expense')),
  amount            INTEGER NOT NULL CHECK (amount > 0),
  category_id       INTEGER REFERENCES categories(id),
  description       TEXT,
  occurred_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d', 'now')),
  source_id         INTEGER REFERENCES payment_sources(id), -- which pot paid (auto-capture)
  capture_id        INTEGER REFERENCES captures(id),        -- non-NULL = auto-captured
  transfer_group_id TEXT,                                   -- pairs the two legs of a transfer
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_user     ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_team     ON transactions(team_id);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);

-- Auto-capture (ADR: react-native-auto-capture-request). A payment source is one
-- pot of money the user owns (bank account or credit card; a debit card is an
-- access method to its account, not a source). Sources belong to the user — never
-- team-scoped; target_team_id is the ROUTING RULE deciding which context its
-- auto-captured transactions land in (NULL = personal).
CREATE TABLE IF NOT EXISTS payment_sources (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  name                TEXT    NOT NULL,
  type                TEXT    NOT NULL CHECK (type IN ('account', 'credit_card')),
  bank                TEXT,
  target_team_id      INTEGER REFERENCES teams(id),
  default_category_id INTEGER REFERENCES categories(id),
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_sources_user ON payment_sources(user_id);

-- How a channel's notifications identify a source: by card last-4, or as the
-- channel's only pot (channel_default, for card-less pushes like SPEI).
CREATE TABLE IF NOT EXISTS source_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  source_id  INTEGER NOT NULL REFERENCES payment_sources(id),
  channel    TEXT    NOT NULL,
  match_kind TEXT    NOT NULL CHECK (match_kind IN ('card_last4', 'channel_default')),
  value      TEXT,                                   -- 4 digits for card_last4; NULL for channel_default
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_source_aliases_user   ON source_aliases(user_id);
CREATE INDEX IF NOT EXISTS idx_source_aliases_source ON source_aliases(source_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_aliases_match
  ON source_aliases(user_id, channel, match_kind, value) WHERE deleted_at IS NULL;

-- Ingest ledger: one row per notification evidence. A capture that resolves
-- cleanly auto-posts a transaction; otherwise it stays pending for the review inbox.
CREATE TABLE IF NOT EXISTS captures (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  channel           TEXT    NOT NULL,
  kind              TEXT    NOT NULL DEFAULT 'unknown' CHECK (kind IN ('purchase', 'transfer', 'unknown')),
  direction         TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
  amount            INTEGER NOT NULL CHECK (amount > 0),
  merchant_raw      TEXT,                            -- merchant or transfer counterparty
  last4             TEXT,                            -- as parsed from the notification
  captured_at       TEXT    NOT NULL,                -- ISO-8601 from the device
  notification_hash TEXT,                            -- device-computed; exact-dedup key
  status            TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'duplicate', 'discarded')),
  source_id         INTEGER REFERENCES payment_sources(id),
  duplicate_of      INTEGER REFERENCES captures(id),
  transaction_id    INTEGER REFERENCES transactions(id),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_user   ON captures(user_id);
CREATE INDEX IF NOT EXISTS idx_captures_source ON captures(source_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_captures_hash
  ON captures(user_id, channel, notification_hash)
  WHERE notification_hash IS NOT NULL AND deleted_at IS NULL;

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
