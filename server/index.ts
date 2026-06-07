import 'dotenv/config'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import express from 'express'
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

const app = express()
const port = Number(process.env.PORT ?? 3001)
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL ist leer. Bitte .env füllen.')
}

const sql = neon(databaseUrl)
const allowedAttachmentTypes = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'image/jpeg', 'image/png'])
const allowedAttachmentExtensions = ['.pdf', '.docx', '.txt', '.md', '.jpg', '.jpeg', '.png']

app.use(express.json({ limit: '25mb' }))

app.get('/api/health', async (_request, response) => {
  const result = await sql`select now() as now`
  response.json({ ok: true, database: 'connected', now: result[0].now })
})

app.post('/api/login', async (request, response) => {
  const { username, password } = request.body as { username?: string; password?: string }
  if (!username || !password) {
    response.status(400).json({ message: 'Username und Passwort sind erforderlich.' })
    return
  }

  const rows = await sql`
    select id, username, email, role, active, password_hash
    from app_users
    where username = ${username}
    limit 1
  `
  const user = rows[0]
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    response.status(401).json({ message: 'Login fehlgeschlagen oder Benutzer inaktiv.' })
    return
  }

  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await sql`
    insert into app_sessions (token, user_id, expires_at)
    values (${token}, ${user.id}, ${expiresAt.toISOString()})
  `

  response.json({
    user: toPublicUser(user as DbUser),
    token,
    expiresAt: expiresAt.toISOString(),
  })
})

app.get('/api/session', async (request, response) => {
  const token = getBearerToken(request.headers.authorization)
  if (!token) {
    response.status(401).json({ message: 'Keine gültige Sitzung.' })
    return
  }

  const user = await findSessionUser(token)
  if (!user) {
    response.status(401).json({ message: 'Die Sitzung ist abgelaufen.' })
    return
  }

  response.json({ user })
})

app.get('/api/users', async (_request, response) => {
  response.json(await listUsers())
})

app.post('/api/users', async (request, response) => {
  const { username, email, password } = request.body as { username?: string; email?: string; password?: string }
  if (!username?.trim() || !email?.trim() || !password?.trim()) {
    response.status(400).json({ message: 'Username, E-Mail und Passwort sind erforderlich.' })
    return
  }

  await sql`
    insert into app_users (username, email, password_hash, role, active)
    values (${username.trim()}, ${email.trim()}, ${hashPassword(password)}, 'user', true)
  `
  response.status(201).json(await listUsers())
})

app.patch('/api/users/:id/password', async (request, response) => {
  const { password } = request.body as { password?: string }
  if (!password?.trim()) {
    response.status(400).json({ message: 'Passwort ist erforderlich.' })
    return
  }

  await sql`
    update app_users
    set password_hash = ${hashPassword(password)}
    where id = ${request.params.id}
  `
  response.json(await listUsers())
})

app.delete('/api/users/:id', async (request, response) => {
  await sql`
    update app_users
    set active = false
    where id = ${request.params.id} and role = 'user'
  `
  response.json(await listUsers())
})

app.get('/api/circulations', async (_request, response) => {
  response.json(await listCirculations())
})

app.get('/api/circulations/changed', async (request, response) => {
  const since = typeof request.query.since === 'string' ? request.query.since : ''
  if (!since || Number.isNaN(Date.parse(since))) {
    response.status(400).json({ message: 'Ein gültiger since-Zeitpunkt ist erforderlich.' })
    return
  }

  const [serverTime] = await sql`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`
  response.json({
    serverNow: serverTime.now,
    circulations: await listChangedCirculations(since),
  })
})

app.post('/api/circulations', async (request, response) => {
  const { title, text, attachments, deadline, initiatorId, recipients } = request.body as {
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
    response.status(400).json({ message: 'Titel, Deadline und Empfänger sind erforderlich.' })
    return
  }
  if (cleanAttachments.some((attachment) => !isAllowedAttachment(attachment))) {
    response.status(400).json({ message: 'Mindestens ein Anhang hat einen nicht erlaubten Dateityp.' })
    return
  }

  const created = await sql`
    insert into circulations (title, body, attachments, deadline, initiator_id)
    values (${title.trim()}, ${text?.trim() || null}, ${JSON.stringify(cleanAttachments)}::jsonb, ${deadline}, ${initiatorId})
    returning id
  `
  for (const recipient of cleanRecipients) {
    await sql`
      insert into circulation_recipients (circulation_id, user_id, role)
      values (${created[0].id}, ${recipient.userId}, ${recipient.role})
    `
  }

  response.status(201).json(await listCirculations())
})

app.post('/api/circulations/:id/vote', async (request, response) => {
  const { userId, status, comment, reason } = request.body as {
    userId?: string
    status?: 'approved' | 'rejected' | 'acknowledged'
    comment?: string
    reason?: string
  }
  if (!userId || !status) {
    response.status(400).json({ message: 'User und Votum sind erforderlich.' })
    return
  }
  if (status === 'rejected' && !reason?.trim()) {
    response.status(400).json({ message: 'Eine Ablehnung benötigt eine Begründung.' })
    return
  }

  await sql`
    update circulation_recipients
    set status = ${status}, comment = ${comment?.trim() || null}, reason = ${reason?.trim() || null}, voted_at = now()
    where circulation_id = ${request.params.id} and user_id = ${userId}
  `
  await sql`
    update circulations
    set updated_at = now()
    where id = ${request.params.id}
  `
  response.json(await listCirculations())
})

await ensureCirculationUpdatedAt()
await ensureSessionTable()
await ensureAdmin()

app.listen(port, () => {
  console.log(`API läuft auf http://127.0.0.1:${port}`)
})

async function ensureAdmin() {
  await sql`
    insert into app_users (username, email, password_hash, role, active)
    values ('admin', 'admin@behoerde.example', ${hashPassword('admin')}, 'admin', true)
    on conflict (username) do nothing
  `
}

async function ensureSessionTable() {
  await sql.query(`
    create table if not exists app_sessions (
      token text primary key,
      user_id uuid not null references app_users(id) on delete cascade,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `)
  await sql`delete from app_sessions where expires_at <= now()`
}

async function ensureCirculationUpdatedAt() {
  await sql.query(`
    alter table circulations
    add column if not exists updated_at timestamptz not null default now()
  `)
}

async function findSessionUser(token: string) {
  const rows = await sql`
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

function getBearerToken(header: string | undefined) {
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

async function listUsers() {
  return sql`
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
  const rows = values.length ? await sql.query(query, values) : await sql.query(query)
  return mapCirculationRows(rows)
}

function mapCirculationRows(rows: Awaited<ReturnType<typeof sql.query>>) {
  const queryRows = rows as Array<Record<string, unknown>>
  return queryRows.map((row) => ({
    ...row,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    recipients: Array.isArray(row.recipients) ? row.recipients : [],
  }))
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
