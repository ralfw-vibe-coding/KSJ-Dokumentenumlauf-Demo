drop table if exists app_sessions;
drop table if exists circulation_recipients;
drop table if exists circulations;
drop table if exists app_users;

create table app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  email text not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'user')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table circulations (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  attachments jsonb not null default '[]'::jsonb,
  deadline date not null,
  initiator_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table circulation_recipients (
  circulation_id uuid not null references circulations(id) on delete cascade,
  user_id uuid not null references app_users(id),
  role text not null check (role in ('approver', 'ack')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'acknowledged')),
  comment text,
  reason text,
  voted_at timestamptz,
  primary key (circulation_id, user_id)
);

create table app_sessions (
  token text primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
