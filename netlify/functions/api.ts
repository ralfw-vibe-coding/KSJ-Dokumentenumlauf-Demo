import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { neon } from '@neondatabase/serverless'

type RecipientInput = {
  userId: string
  role: 'approver' | 'ack'
}

type AttachmentInput = {
  name: string
  type: string
  size: number
  dataUrl: string
}

type DbUser = {
  id: string
  username: string
  email: string
  role: 'admin' | 'user'
  active: boolean
}

const netlifyGlobal = globalThis as typeof globalThis & {
  Netlify?: { env: { get(name: string): string | undefined } }
}
const databaseUrl =
  netlifyGlobal.Netlify?.env.get('DATABASE_URL') ??
  netlifyGlobal.Netlify?.env.get('database_url') ??
  process.env.DATABASE_URL ??
  process.env.database_url
const sql = databaseUrl ? neon(databaseUrl) : null
const allowedAttachmentTypes = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'image/jpeg', 'image/png'])
const allowedAttachmentExtensions = ['.pdf', '.docx', '.txt', '.md', '.jpg', '.jpeg', '.png']

let initPromise: Promise<void> | null = null

export default async (request: Request) => {
  try {
    if (!sql) return json({ message: 'DATABASE_URL ist nicht konfiguriert.' }, 500)
    initPromise ??= initializeDatabase()
    await initPromise

    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/api/, '') || '/'

    if (request.method === 'GET' && path === '/health') {
      const result = await sql`select now() as now`
      return json({ ok: true, database: 'connected', now: result[0].now })
    }

    if (request.method === 'POST' && path === '/login') {
      return handleLogin(request)
    }

    if (request.method === 'GET' && path === '/session') {
      const user = await findSessionUser(getBearerToken(request.headers.get('authorization')))
      if (!user) return json({ message: 'Die Sitzung ist abgelaufen.' }, 401)
      return json({ user })
    }

    if (request.method === 'GET' && path === '/users') {
      return json(await listUsers())
    }

    if (request.method === 'POST' && path === '/users') {
      return handleCreateUser(request)
    }

    const passwordMatch = path.match(/^\/users\/([^/]+)\/password$/)
    if (request.method === 'PATCH' && passwordMatch) {
      return handleChangePassword(passwordMatch[1], request)
    }

    const userMatch = path.match(/^\/users\/([^/]+)$/)
    if (request.method === 'DELETE' && userMatch) {
      await sql`
        update app_users
        set active = false
        where id = ${userMatch[1]} and role = 'user'
      `
      return json(await listUsers())
    }

    if (request.method === 'GET' && path === '/circulations') {
      return json(await listCirculations())
    }

    if (request.method === 'GET' && path === '/circulations/changed') {
      const since = url.searchParams.get('since') ?? ''
      if (!since || Number.isNaN(Date.parse(since))) {
        return json({ message: 'Ein gültiger since-Zeitpunkt ist erforderlich.' }, 400)
      }
      const [serverTime] = await sql`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`
      return json({ serverNow: serverTime.now, circulations: await listChangedCirculations(since) })
    }

    if (request.method === 'POST' && path === '/circulations') {
      return handleCreateCirculation(request)
    }

    const voteMatch = path.match(/^\/circulations\/([^/]+)\/vote$/)
    if (request.method === 'POST' && voteMatch) {
      return handleVote(voteMatch[1], request)
    }

    return json({ message: 'API-Route nicht gefunden.' }, 404)
  } catch (error) {
    console.error(error)
    return json({ message: error instanceof Error ? error.message : 'Serverfehler.' }, 500)
  }
}

export const config = {
  path: '/api/*',
}

async function handleLogin(request: Request) {
  const { username, password } = await request.json() as { username?: string; password?: string }
  if (!username || !password) return json({ message: 'Username und Passwort sind erforderlich.' }, 400)

  const rows = await sql!`
    select id, username, email, role, active, password_hash
    from app_users
    where username = ${username}
    limit 1
  `
  const user = rows[0]
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    return json({ message: 'Login fehlgeschlagen oder Benutzer inaktiv.' }, 401)
  }

  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await sql!`
    insert into app_sessions (token, user_id, expires_at)
    values (${token}, ${user.id}, ${expiresAt.toISOString()})
  `

  return json({ user: toPublicUser(user as DbUser), token, expiresAt: expiresAt.toISOString() })
}

async function handleCreateUser(request: Request) {
  const { username, email, password } = await request.json() as { username?: string; email?: string; password?: string }
  if (!username?.trim() || !email?.trim() || !password?.trim()) {
    return json({ message: 'Username, E-Mail und Passwort sind erforderlich.' }, 400)
  }

  await sql!`
    insert into app_users (username, email, password_hash, role, active)
    values (${username.trim()}, ${email.trim()}, ${hashPassword(password)}, 'user', true)
  `
  return json(await listUsers(), 201)
}

async function handleChangePassword(userId: string, request: Request) {
  const { password } = await request.json() as { password?: string }
  if (!password?.trim()) return json({ message: 'Passwort ist erforderlich.' }, 400)

  await sql!`
    update app_users
    set password_hash = ${hashPassword(password)}
    where id = ${userId}
  `
  return json(await listUsers())
}

async function handleCreateCirculation(request: Request) {
  const { title, text, attachments, deadline, initiatorId, recipients } = await request.json() as {
    title?: string
    text?: string
    attachments?: AttachmentInput[]
    deadline?: string
    initiatorId?: string
    recipients?: RecipientInput[]
  }
  const cleanRecipients = recipients?.filter((recipient) => recipient.userId && ['approver', 'ack'].includes(recipient.role)) ?? []
  const cleanAttachments = attachments?.map(cleanAttachment) ?? []
  if (!title?.trim() || !deadline || !initiatorId || cleanRecipients.length === 0) {
    return json({ message: 'Titel, Deadline und Empfänger sind erforderlich.' }, 400)
  }
  if (cleanAttachments.some((attachment) => !isAllowedAttachment(attachment))) {
    return json({ message: 'Mindestens ein Anhang hat einen nicht erlaubten Dateityp.' }, 400)
  }

  const created = await sql!`
    insert into circulations (title, body, attachments, deadline, initiator_id)
    values (${title.trim()}, ${text?.trim() || null}, ${JSON.stringify(cleanAttachments)}::jsonb, ${deadline}, ${initiatorId})
    returning id
  `
  for (const recipient of cleanRecipients) {
    await sql!`
      insert into circulation_recipients (circulation_id, user_id, role)
      values (${created[0].id}, ${recipient.userId}, ${recipient.role})
    `
  }

  return json(await listCirculations(), 201)
}

async function handleVote(circulationId: string, request: Request) {
  const { userId, status, comment, reason } = await request.json() as {
    userId?: string
    status?: 'approved' | 'rejected' | 'acknowledged'
    comment?: string
    reason?: string
  }
  if (!userId || !status) return json({ message: 'User und Votum sind erforderlich.' }, 400)
  if (status === 'rejected' && !reason?.trim()) return json({ message: 'Eine Ablehnung benötigt eine Begründung.' }, 400)

  await sql!`
    update circulation_recipients
    set status = ${status}, comment = ${comment?.trim() || null}, reason = ${reason?.trim() || null}, voted_at = now()
    where circulation_id = ${circulationId} and user_id = ${userId}
  `
  await sql!`
    update circulations
    set updated_at = now()
    where id = ${circulationId}
  `
  return json(await listCirculations())
}

async function initializeDatabase() {
  await sql!.query(`
    create table if not exists app_users (
      id uuid primary key default gen_random_uuid(),
      username text not null unique,
      email text not null,
      password_hash text not null,
      role text not null check (role in ('admin', 'user')),
      active boolean not null default true,
      created_at timestamptz not null default now()
    )
  `)
  await sql!.query(`
    create table if not exists circulations (
      id uuid primary key default gen_random_uuid(),
      title text not null,
      body text,
      attachments jsonb not null default '[]'::jsonb,
      deadline date not null,
      initiator_id uuid not null references app_users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `)
  await sql!.query(`
    create table if not exists circulation_recipients (
      circulation_id uuid not null references circulations(id) on delete cascade,
      user_id uuid not null references app_users(id),
      role text not null check (role in ('approver', 'ack')),
      status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'acknowledged')),
      comment text,
      reason text,
      voted_at timestamptz,
      primary key (circulation_id, user_id)
    )
  `)
  await sql!.query(`
    create table if not exists app_sessions (
      token text primary key,
      user_id uuid not null references app_users(id) on delete cascade,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `)
  await sql!.query(`
    alter table circulations
    add column if not exists updated_at timestamptz not null default now()
  `)
  await sql!`
    insert into app_users (username, email, password_hash, role, active)
    values ('admin', 'admin@behoerde.example', ${hashPassword('admin')}, 'admin', true)
    on conflict (username) do nothing
  `
  await sql!`delete from app_sessions where expires_at <= now()`
}

async function findSessionUser(token: string | null) {
  if (!token) return null
  const rows = await sql!`
    select u.id, u.username, u.email, u.role, u.active
    from app_sessions s
    join app_users u on u.id = s.user_id
    where s.token = ${token}
      and s.expires_at > now()
      and u.active = true
    limit 1
  `
  return rows[0] ? toPublicUser(rows[0] as DbUser) : null
}

async function listUsers() {
  return sql!`
    select id, username, email, role, active
    from app_users
    order by role, username
  `
}

async function listCirculations() {
  return listCirculationsWhere('')
}

async function listChangedCirculations(since: string) {
  return listCirculationsWhere('where c.updated_at > $1', [since])
}

async function listCirculationsWhere(whereClause: string, values: string[] = []) {
  const query = `
    select
      c.id,
      c.title,
      c.body as text,
      c.attachments,
      c.deadline::text as deadline,
      c.initiator_id as "initiatorId",
      to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
      to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt",
      coalesce(
        json_agg(
          json_build_object(
            'userId', r.user_id,
            'role', r.role,
            'status', r.status,
            'comment', r.comment,
            'reason', r.reason,
            'votedAt', r.voted_at::date::text
          )
          order by r.role, r.user_id
        ) filter (where r.user_id is not null),
        '[]'::json
      ) as recipients
    from circulations c
    left join circulation_recipients r on r.circulation_id = c.id
    ${whereClause}
    group by c.id
    order by c.created_at desc
  `
  const rows = values.length ? await sql!.query(query, values) : await sql!.query(query)
  const queryRows = rows as Array<Record<string, unknown>>
  return queryRows.map((row) => ({
    ...row,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    recipients: Array.isArray(row.recipients) ? row.recipients : [],
  }))
}

function getBearerToken(header: string | null) {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim()
}

function toPublicUser(user: DbUser) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    active: user.active,
  }
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(password, salt, 64)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function cleanAttachment(attachment: AttachmentInput) {
  return {
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    dataUrl: attachment.dataUrl,
  }
}

function isAllowedAttachment(attachment: AttachmentInput) {
  return allowedAttachmentTypes.has(attachment.type) || allowedAttachmentExtensions.some((extension) => attachment.name.toLowerCase().endsWith(extension))
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
