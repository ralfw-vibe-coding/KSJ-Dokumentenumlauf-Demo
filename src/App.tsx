import { useEffect, useRef, useState } from 'react'
import type { FormEvent, InputHTMLAttributes, ReactNode } from 'react'
import {
  Check,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  Gavel,
  LogOut,
  Plus,
  Shield,
  Trash2,
  UserPlus,
  X,
  XCircle,
} from 'lucide-react'
import './App.css'

type Role = 'admin' | 'user'
type RecipientRole = 'approver' | 'ack'
type RunStatus = 'open' | 'completed' | 'cancelled' | 'expired'
type VoteStatus = 'pending' | 'approved' | 'rejected' | 'acknowledged'

type User = {
  id: string
  username: string
  email: string
  role: Role
  active: boolean
}

type Recipient = {
  userId: string
  role: RecipientRole
  status: VoteStatus
  comment?: string
  reason?: string
  votedAt?: string
}

type Attachment = {
  name: string
  type: string
  size: number
  dataUrl: string
}

type Circulation = {
  id: string
  title: string
  text?: string
  attachments: Attachment[]
  deadline: string
  initiatorId: string
  recipients: Recipient[]
  createdAt: string
  updatedAt: string
}

type Session = User
type LoginResult = {
  user: User
  token: string
  expiresAt: string
}
type ChangedCirculationsResult = {
  serverNow: string
  circulations: Circulation[]
}

const sessionTokenKey = 'dokumentenumlauf.sessionToken'
const initialChangeCursor = '1970-01-01T00:00:00.000Z'

const todayString = () => new Date().toISOString().slice(0, 10)
const allowedAttachmentTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'image/jpeg', 'image/png']
const allowedAttachmentExtensions = ['.pdf', '.docx', '.txt', '.md', '.jpg', '.jpeg', '.png']

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    throw new Error(body.message ?? `Die Anfrage ist fehlgeschlagen (${response.status} ${path}).`)
  }
  return response.json() as Promise<T>
}

function App() {
  const [users, setUsers] = useState<User[]>([])
  const [circulations, setCirculations] = useState<Circulation[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [restoringSession, setRestoringSession] = useState(true)
  const changeCursorRef = useRef(initialChangeCursor)

  const currentUser = users.find((user) => user.id === session?.id) ?? session
  const selected = circulations.find((item) => item.id === selectedId)

  function applyFullData(loadedUsers: User[], loadedCirculations: Circulation[]) {
    setUsers(loadedUsers)
    setCirculations(loadedCirculations)
    changeCursorRef.current = latestUpdatedAt(loadedCirculations) ?? initialChangeCursor
  }

  useEffect(() => {
    const token = localStorage.getItem(sessionTokenKey)
    if (!token) {
      queueMicrotask(() => setRestoringSession(false))
      return
    }

    queueMicrotask(async () => {
      try {
        const { user } = await api<{ user: User }>('/api/session', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const [loadedUsers, loadedCirculations] = await Promise.all([
          api<User[]>('/api/users'),
          api<Circulation[]>('/api/circulations'),
        ])
        applyFullData(loadedUsers, loadedCirculations)
        setSession(user)
      } catch {
        localStorage.removeItem(sessionTokenKey)
      } finally {
        setRestoringSession(false)
      }
    })
  }, [])

  useEffect(() => {
    if (!currentUser || currentUser.role === 'admin') return

    const interval = window.setInterval(() => {
      queueMicrotask(async () => {
        try {
          const changed = await api<ChangedCirculationsResult>(`/api/circulations/changed?since=${encodeURIComponent(changeCursorRef.current)}`)
          changeCursorRef.current = changed.serverNow
          if (changed.circulations.length === 0) return

          const knownTasks = new Set(visibleTaskKeys(circulations, currentUser.id))
          const mergedCirculations = mergeCirculations(circulations, changed.circulations)
          const latestTasks = visibleTaskKeys(mergedCirculations, currentUser.id)
          const hasNewTask = latestTasks.some((key) => !knownTasks.has(key))

          setCirculations(mergedCirculations)
          if (hasNewTask) setNotice('Neue Aufgabe empfangen.')
        } catch {
          // Der Auto-Refresh bleibt leise; sichtbare Fehler entstehen weiter bei aktiven Aktionen.
        }
      })
    }, 60_000)

    return () => window.clearInterval(interval)
  }, [currentUser, circulations])

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setLoginError('')
    const form = new FormData(event.currentTarget)
    try {
      const result = await api<LoginResult>('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: String(form.get('username') ?? ''),
          password: String(form.get('password') ?? ''),
        }),
      })
      const [loadedUsers, loadedCirculations] = await Promise.all([
        api<User[]>('/api/users'),
        api<Circulation[]>('/api/circulations'),
      ])
      applyFullData(loadedUsers, loadedCirculations)
      localStorage.setItem(sessionTokenKey, result.token)
      setSession(result.user)
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login fehlgeschlagen.')
    } finally {
      setLoading(false)
    }
  }

  async function addUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const username = String(form.get('new-user-name') ?? '').trim()
    const email = String(form.get('new-user-email') ?? '').trim()
    const password = String(form.get('new-user-secret') ?? '').trim()
    if (!username || !email || !password) return
    setUsers(await api<User[]>('/api/users', { method: 'POST', body: JSON.stringify({ username, email, password }) }))
    setNotice(`User ${username} wurde angelegt.`)
    formElement.reset()
  }

  async function changePassword(userId: string, password: string) {
    if (!password.trim()) return
    try {
      setUsers(await api<User[]>(`/api/users/${userId}/password`, { method: 'PATCH', body: JSON.stringify({ password }) }))
      setNotice('Passwort wurde geändert.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Passwort konnte nicht geändert werden.')
    }
  }

  async function deactivateUser(userId: string) {
    setUsers(await api<User[]>(`/api/users/${userId}`, { method: 'DELETE' }))
    setNotice('User wurde deaktiviert.')
  }

  async function createCirculation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentUser || currentUser.role === 'admin') return
    try {
      const form = new FormData(event.currentTarget)
      const title = String(form.get('title') ?? '').trim()
      const deadline = String(form.get('deadline') ?? '')
      const text = String(form.get('text') ?? '').trim()
      const approvers = form.getAll('approvers').map(String)
      const acknowledgers = form.getAll('acknowledgers').map(String).filter((id) => !approvers.includes(id))
      if (!title || !deadline || approvers.length + acknowledgers.length === 0) return
      const attachments = await readAttachments(form.getAll('attachments').filter((entry): entry is File => entry instanceof File && entry.size > 0))
      const recipients: Pick<Recipient, 'userId' | 'role'>[] = [
        ...approvers.map((userId) => ({ userId, role: 'approver' as const })),
        ...acknowledgers.map((userId) => ({ userId, role: 'ack' as const })),
      ]
      const updated = await api<Circulation[]>('/api/circulations', {
        method: 'POST',
        body: JSON.stringify({ title, deadline, text, attachments, initiatorId: currentUser.id, recipients }),
      })
      setCirculations(updated)
      setSelectedId(updated[0]?.id ?? null)
      setShowNew(false)
      setNotice('Umlauf wurde gestartet.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Umlauf konnte nicht gestartet werden.')
    }
  }

  async function vote(circulationId: string, status: VoteStatus, comment: string, reason: string) {
    if (!currentUser) return
    setCirculations(await api<Circulation[]>(`/api/circulations/${circulationId}/vote`, {
      method: 'POST',
      body: JSON.stringify({ userId: currentUser.id, status, comment, reason }),
    }))
    setNotice('Votum wurde gespeichert.')
  }

  function logout() {
    localStorage.removeItem(sessionTokenKey)
    setSession(null)
    setUsers([])
    setCirculations([])
    changeCursorRef.current = initialChangeCursor
  }

  if (restoringSession) {
    return (
      <main className="login-screen">
        <div className="login-card">
          <div className="brand-mark">
            <Shield size={28} />
          </div>
          <h1>Dokumentenumlauf</h1>
          <p className="muted">Sitzung wird geprüft.</p>
        </div>
      </main>
    )
  }

  if (!session || !currentUser) {
    return <Login onLogin={login} error={loginError} loading={loading} />
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Behörde Dokumentenumlauf</p>
          <h1>{currentUser.role === 'admin' ? 'Administration' : 'Dashboard'}</h1>
        </div>
        <div className="user-chip">
          {currentUser.role === 'admin' ? <Shield size={16} /> : <FileText size={16} />}
          {currentUser.username}
          <button className="icon-button" onClick={logout} aria-label="Abmelden">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {notice ? <div className="notice">{notice}</div> : null}

      {currentUser.role === 'admin' ? (
        <AdminPage users={users} onAddUser={addUser} onChangePassword={changePassword} onDeactivate={deactivateUser} />
      ) : (
        <>
          <Dashboard
            user={currentUser}
            users={users}
            circulations={circulations}
            onOpen={setSelectedId}
            onCreate={() => setShowNew(true)}
          />
          {showNew ? (
            <NewCirculationModal users={users} currentUserId={currentUser.id} onClose={() => setShowNew(false)} onCreate={createCirculation} />
          ) : null}
          {selected ? (
            <DetailModal
              circulation={selected}
              users={users}
              currentUserId={currentUser.id}
              onClose={() => setSelectedId(null)}
              onVote={vote}
            />
          ) : null}
        </>
      )}
    </div>
  )
}

function Login({ onLogin, error, loading }: { onLogin: (event: FormEvent<HTMLFormElement>) => void; error: string; loading: boolean }) {
  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={onLogin}>
        <div className="brand-mark">
          <Shield size={28} />
        </div>
        <h1>Dokumentenumlauf</h1>
        <p className="muted">Anmeldung für interne Freigaben und Kenntnisnahmen.</p>
        <label>
          Benutzername
          <input name="username" autoComplete="username" />
        </label>
        <label>
          Passwort
          <input name="password" type="password" autoComplete="current-password" />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={loading}>
          <Check size={18} />
          {loading ? 'Anmeldung läuft' : 'Anmelden'}
        </button>
        <p className="hint">Bitte mit dem zugewiesenen Benutzerkonto anmelden.</p>
      </form>
    </main>
  )
}

function AdminPage({
  users,
  onAddUser,
  onChangePassword,
  onDeactivate,
}: {
  users: User[]
  onAddUser: (event: FormEvent<HTMLFormElement>) => void
  onChangePassword: (userId: string, password: string) => void
  onDeactivate: (userId: string) => void
}) {
  return (
    <main className="admin-grid">
      <section className="panel">
        <div className="section-title">
          <UserPlus size={20} />
          <h2>User anlegen</h2>
        </div>
        <form className="stack-form" onSubmit={onAddUser}>
          <input name="new-user-name" placeholder="Benutzername" autoComplete="off" />
          <input name="new-user-email" placeholder="E-Mail" type="email" autoComplete="off" />
          <VisiblePasswordInput name="new-user-secret" placeholder="Initiales Passwort" autoComplete="new-password" />
          <button className="primary-button" type="submit">
            <Plus size={18} />
            Anlegen
          </button>
        </form>
      </section>
      <section className="panel wide">
        <div className="section-title">
          <Shield size={20} />
          <h2>Alle User</h2>
        </div>
        <div className="table">
          {users.map((user) => (
            <div className="table-row" key={user.id}>
              <strong>{user.username}</strong>
              <span>{user.email}</span>
              <span className={user.active ? 'status active' : 'status inactive'}>{user.active ? 'aktiv' : 'inaktiv'}</span>
              {user.role === 'admin' ? (
                <>
                  <PasswordMiniForm userId={user.id} onSubmit={onChangePassword} />
                  <span className="muted">Username fix</span>
                </>
              ) : (
                <>
                  <PasswordMiniForm userId={user.id} onSubmit={onChangePassword} />
                  <button className="ghost-button danger" onClick={() => onDeactivate(user.id)}>
                    <Trash2 size={16} />
                    Deaktivieren
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

function PasswordMiniForm({ userId, onSubmit }: { userId: string; onSubmit: (userId: string, password: string) => void }) {
  const [password, setPassword] = useState('')
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(userId, password)
        setPassword('')
      }}
    >
      <VisiblePasswordInput
        name={`change-secret-${userId}`}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Neues Passwort"
        autoComplete="new-password"
      />
      <button className="icon-button" aria-label="Passwort speichern">
        <Check size={16} />
      </button>
    </form>
  )
}

function Dashboard({
  user,
  users,
  circulations,
  onOpen,
  onCreate,
}: {
  user: User
  users: User[]
  circulations: Circulation[]
  onOpen: (id: string) => void
  onCreate: () => void
}) {
  const mine = circulations.filter((item) => item.initiatorId === user.id)
  const myTasks = circulations.filter((item) => isVisibleTask(item, user.id))
  const doneToday = circulations.filter((item) => item.recipients.some((recipient) => recipient.userId === user.id && recipient.votedAt === todayString()))

  return (
    <main className="dashboard">
      <section>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Initiator</p>
            <h2>Meine Umläufe</h2>
          </div>
          <button className="primary-button" onClick={onCreate}>
            <Plus size={18} />
            Neuer Umlauf
          </button>
        </div>
        <div className="kanban three">
          <Column title="Offen" items={mine.filter((item) => getStatus(item) === 'open')} users={users} onOpen={onOpen} mode="mine" />
          <Column title="Abgeschlossen" items={mine.filter((item) => getStatus(item) === 'completed')} users={users} onOpen={onOpen} mode="mine" />
          <Column title="Abgebrochen" items={mine.filter((item) => ['cancelled', 'expired'].includes(getStatus(item)))} users={users} onOpen={onOpen} mode="mine" />
        </div>
      </section>
      <section>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Empfänger</p>
            <h2>Zu erledigen</h2>
          </div>
        </div>
        <div className="kanban two">
          <Column title="Zu erledigen" items={myTasks} users={users} onOpen={onOpen} mode="task" userId={user.id} />
          <Column title="Heute erledigt" items={doneToday} users={users} onOpen={onOpen} mode="task" userId={user.id} />
        </div>
      </section>
    </main>
  )
}

function Column(props: { title: string; items: Circulation[]; users: User[]; onOpen: (id: string) => void; mode: 'mine' | 'task'; userId?: string }) {
  return (
    <div className="column">
      <div className="column-head">
        <h3>{props.title}</h3>
        <span>{props.items.length}</span>
      </div>
      <div className="card-list">
        {props.items.map((item) => (
          <CirculationCard key={item.id} {...props} item={item} />
        ))}
        {props.items.length === 0 ? <p className="empty">Keine Einträge</p> : null}
      </div>
    </div>
  )
}

function CirculationCard({ item, users, onOpen, mode, userId }: { item: Circulation; users: User[]; onOpen: (id: string) => void; mode: 'mine' | 'task'; userId?: string }) {
  const phase = getPhase(item)
  const recipient = item.recipients.find((entry) => entry.userId === userId)
  const progress = responseProgress(item)
  const status = getStatus(item)
  const showProgress = status === 'open'
  const ended = endedAt(item)
  return (
    <button className="circulation-card" onClick={() => onOpen(item.id)}>
      {showProgress ? <span className="vertical-progress" style={{ height: `${progress}%` }} /> : null}
      <h4>{item.title}</h4>
      {mode === 'mine' ? (
        <p>{phase} · {pendingVotes(item)} offen</p>
      ) : (
        <p>
          {findUser(users, item.initiatorId)?.username} · {recipient?.role === 'approver' ? 'Genehmiger' : 'Zur Kenntnis'}
        </p>
      )}
      {showProgress ? (
        <div className="progress-row" aria-label={`${formatPercent(progress)} reagiert`}>
          <div className="progress-track">
            <span style={{ width: `${progress}%` }} />
          </div>
          <strong>{formatPercent(progress)}</strong>
        </div>
      ) : null}
      <div className="card-date-row">
        {status === 'open' ? <span className={`traffic ${getTraffic(item.deadline)}`} /> : null}
        <span>
          Fällig: {formatDate(item.deadline)}
          {ended ? ` · Beendet: ${formatDate(ended)}` : ''}
        </span>
      </div>
    </button>
  )
}

function NewCirculationModal({ users, currentUserId, onClose, onCreate }: { users: User[]; currentUserId: string; onClose: () => void; onCreate: (event: FormEvent<HTMLFormElement>) => void }) {
  const recipients = users.filter((user) => user.role === 'user' && user.active && user.id !== currentUserId)
  const [roles, setRoles] = useState<Record<string, RecipientRole | ''>>({})
  return (
    <Modal title="Neuer Umlauf" onClose={onClose}>
      <form className="stack-form" onSubmit={onCreate}>
        <input name="title" placeholder="Titel" required />
        <textarea name="text" placeholder="Beschreibung / Anschreiben" rows={4} />
        <label>
          Anhänge
          <input name="attachments" type="file" multiple accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,image/jpeg,image/png" />
        </label>
        <input name="deadline" type="date" required min={todayString()} />
        <div className="recipient-picker">
          {recipients.length === 0 ? <p className="empty">Keine aktiven Empfänger vorhanden.</p> : null}
          {recipients.map((user) => (
            <div className="recipient-row" key={user.id}>
              <strong>{user.username}</strong>
              <label className={roles[user.id] === 'ack' ? 'disabled-option' : ''}>
                <input
                  type="checkbox"
                  name="approvers"
                  value={user.id}
                  checked={roles[user.id] === 'approver'}
                  disabled={roles[user.id] === 'ack'}
                  onChange={(event) => setRoles((current) => ({ ...current, [user.id]: event.target.checked ? 'approver' : '' }))}
                />
                Genehmiger
              </label>
              <label className={roles[user.id] === 'approver' ? 'disabled-option' : ''}>
                <input
                  type="checkbox"
                  name="acknowledgers"
                  value={user.id}
                  checked={roles[user.id] === 'ack'}
                  disabled={roles[user.id] === 'approver'}
                  onChange={(event) => setRoles((current) => ({ ...current, [user.id]: event.target.checked ? 'ack' : '' }))}
                />
                Zur Kenntnis
              </label>
            </div>
          ))}
        </div>
        <button className="primary-button" type="submit">
          <Plus size={18} />
          Umlauf starten
        </button>
      </form>
    </Modal>
  )
}

function DetailModal({ circulation, users, currentUserId, onClose, onVote }: { circulation: Circulation; users: User[]; currentUserId: string; onClose: () => void; onVote: (id: string, status: VoteStatus, comment: string, reason: string) => void }) {
  const [comment, setComment] = useState('')
  const [reason, setReason] = useState('')
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null)
  const recipient = circulation.recipients.find((entry) => entry.userId === currentUserId)
  const canVote = recipient?.status === 'pending' && isVisibleTask(circulation, currentUserId)
  const status = getStatus(circulation)
  const ended = endedAt(circulation)

  return (
    <Modal title={circulation.title} onClose={onClose}>
      <div className="detail-grid">
        <div>
          <p className="description-box">{circulation.text || 'Keine Beschreibung hinterlegt.'}</p>
          <div className="facts">
            <Badge>{statusLabel(status)}</Badge>
            <Badge>{getPhase(circulation)}</Badge>
            <Badge>Fällig: {formatDate(circulation.deadline)}</Badge>
            {ended ? <Badge>Beendet: {formatDate(ended)}</Badge> : null}
          </div>
          <h3>Anhänge</h3>
          <div className="attachment-list">
            {circulation.attachments.length ? circulation.attachments.map((attachment) => (
              <div className="attachment-actions" key={`${attachment.name}-${attachment.size}`}>
                <button className="attachment-open" onClick={() => setPreviewAttachment(attachment)}>
                  <FileText size={15} />
                  {attachment.name}
                </button>
                <a className="attachment-download" href={attachment.dataUrl} download={attachment.name} aria-label={`${attachment.name} herunterladen`}>
                  <Download size={15} />
                </a>
              </div>
            )) : <span>Keine Anhänge</span>}
          </div>
        </div>
        <div>
          <h3>Empfängerstatus</h3>
          <div className="recipient-status-list">
            {circulation.recipients.map((entry) => (
              <div className="recipient-status" key={entry.userId}>
                {entry.status === 'pending' ? <Clock3 size={17} /> : entry.status === 'rejected' ? <XCircle size={17} /> : <CheckCircle2 size={17} />}
                <div>
                  <strong>{findUser(users, entry.userId)?.username}</strong>
                  <p>{entry.role === 'approver' ? 'Genehmiger' : 'Zur Kenntnis'} · {voteLabel(entry.status)}</p>
                  {entry.reason ? <p className="error">Begründung: {entry.reason}</p> : null}
                  {entry.comment ? <p className="muted">Kommentar: {entry.comment}</p> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {canVote ? (
        <div className="vote-box">
          <h3>Mein Votum</h3>
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Optionaler Kommentar" rows={3} />
          {recipient?.role === 'approver' ? (
            <>
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Pflichtbegründung bei Ablehnung" rows={3} />
              <div className="button-row">
                <button className="primary-button" onClick={() => onVote(circulation.id, 'approved', comment, '')}><Gavel size={18} />Genehmigen</button>
                <button className="danger-button" disabled={!reason.trim()} onClick={() => onVote(circulation.id, 'rejected', comment, reason)}><X size={18} />Ablehnen</button>
              </div>
            </>
          ) : (
            <button className="primary-button" onClick={() => onVote(circulation.id, 'acknowledged', comment, '')}><Check size={18} />Zur Kenntnis genommen</button>
          )}
        </div>
      ) : null}
      {previewAttachment ? <AttachmentPreview attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} /> : null}
    </Modal>
  )
}

function AttachmentPreview({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  return (
    <div className="preview-backdrop">
      <section className="preview-modal">
        <div className="modal-head">
          <h2>{attachment.name}</h2>
          <div className="button-row">
            <a className="ghost-button" href={attachment.dataUrl} download={attachment.name}>
              <Download size={16} />
              Herunterladen
            </a>
            <button className="icon-button" onClick={onClose} aria-label="Vorschau schließen"><X size={18} /></button>
          </div>
        </div>
        <div className="preview-body">
          {renderAttachmentPreview(attachment)}
        </div>
      </section>
    </div>
  )
}

function renderAttachmentPreview(attachment: Attachment) {
  if (attachment.type.startsWith('image/')) {
    return <img className="preview-image" src={attachment.dataUrl} alt={attachment.name} />
  }
  if (attachment.type === 'application/pdf') {
    return <iframe className="preview-frame" src={attachment.dataUrl} title={attachment.name} />
  }
  if (attachment.type.startsWith('text/') || attachment.name.toLowerCase().endsWith('.md')) {
    return <iframe className="preview-frame" src={attachment.dataUrl} title={attachment.name} />
  }
  return (
    <div className="preview-unavailable">
      <FileText size={42} />
      <h3>Vorschau nicht verfügbar</h3>
      <p>Dieses Dateiformat kann der Browser nicht direkt anzeigen. Bitte lade die Datei herunter.</p>
    </div>
  )
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="modal">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Schließen"><X size={18} /></button>
        </div>
        {children}
      </section>
    </div>
  )
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>
}

function VisiblePasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [focused, setFocused] = useState(false)
  return (
    <input
      {...props}
      type={focused ? 'text' : 'password'}
      onFocus={(event) => {
        setFocused(true)
        props.onFocus?.(event)
      }}
      onBlur={(event) => {
        setFocused(false)
        props.onBlur?.(event)
      }}
    />
  )
}

function getStatus(circulation: Circulation): RunStatus {
  if (new Date(circulation.deadline) < new Date(todayString())) return 'expired'
  if (circulation.recipients.some((recipient) => recipient.status === 'rejected')) return 'cancelled'
  if (circulation.recipients.every((recipient) => recipient.status !== 'pending')) return 'completed'
  return 'open'
}

function endedAt(circulation: Circulation) {
  const status = getStatus(circulation)
  if (status === 'cancelled') {
    return circulation.recipients.find((recipient) => recipient.status === 'rejected')?.votedAt ?? null
  }
  if (status === 'completed') {
    const votedDates = circulation.recipients
      .map((recipient) => recipient.votedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
    return votedDates.at(-1) ?? null
  }
  return null
}

function getPhase(circulation: Circulation) {
  if (getStatus(circulation) !== 'open') return '-'
  return circulation.recipients.filter((recipient) => recipient.role === 'approver').every((recipient) => recipient.status === 'approved')
    ? 'Kenntnisnahme'
    : 'Genehmigung'
}

function isVisibleTask(circulation: Circulation, userId: string) {
  if (getStatus(circulation) !== 'open') return false
  const recipient = circulation.recipients.find((entry) => entry.userId === userId)
  if (!recipient || recipient.status !== 'pending') return false
  if (recipient.role === 'approver') return getPhase(circulation) === 'Genehmigung'
  return getPhase(circulation) === 'Kenntnisnahme'
}

function visibleTaskKeys(circulations: Circulation[], userId: string) {
  return circulations
    .filter((circulation) => isVisibleTask(circulation, userId))
    .map((circulation) => `${circulation.id}:${circulation.recipients.find((recipient) => recipient.userId === userId)?.role ?? ''}`)
}

function mergeCirculations(current: Circulation[], changed: Circulation[]) {
  const changedById = new Map(changed.map((circulation) => [circulation.id, circulation]))
  const existingIds = new Set(current.map((circulation) => circulation.id))
  const merged = current.map((circulation) => changedById.get(circulation.id) ?? circulation)
  const additions = changed.filter((circulation) => !existingIds.has(circulation.id))
  return [...additions, ...merged].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

function latestUpdatedAt(circulations: Circulation[]) {
  return circulations.map((circulation) => circulation.updatedAt).filter(Boolean).sort().at(-1) ?? null
}

function pendingVotes(circulation: Circulation) {
  if (getStatus(circulation) !== 'open') return 0
  if (getPhase(circulation) === 'Genehmigung') {
    return circulation.recipients.filter((entry) => entry.role === 'approver' && entry.status === 'pending').length
  }
  return circulation.recipients.filter((entry) => entry.role === 'ack' && entry.status === 'pending').length
}

function responseProgress(circulation: Circulation) {
  if (circulation.recipients.length === 0) return 0
  return (circulation.recipients.filter((recipient) => recipient.status !== 'pending').length / circulation.recipients.length) * 100
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(value)} %`
}

function getTraffic(deadline: string) {
  const diff = Math.ceil((new Date(deadline).getTime() - new Date().getTime()) / 86_400_000)
  if (diff > 2) return 'green'
  if (diff >= 1) return 'yellow'
  return 'red'
}

function findUser(users: User[], id: string) {
  return users.find((user) => user.id === id)
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value))
}

function statusLabel(status: RunStatus) {
  return { open: 'Offen', completed: 'Abgeschlossen', cancelled: 'Abgebrochen', expired: 'Abgelaufen' }[status]
}

function voteLabel(status: VoteStatus) {
  return { pending: 'ausstehend', approved: 'genehmigt', rejected: 'abgelehnt', acknowledged: 'zur Kenntnis genommen' }[status]
}

async function readAttachments(files: File[]) {
  for (const file of files) {
    if (!allowedAttachmentTypes.includes(file.type) && !allowedAttachmentExtensions.some((extension) => file.name.toLowerCase().endsWith(extension))) {
      throw new Error(`Dateityp nicht erlaubt: ${file.name}`)
    }
  }
  return Promise.all(files.map(readAttachment))
}

function readAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, dataUrl: String(reader.result) })
    reader.onerror = () => reject(new Error(`Datei konnte nicht gelesen werden: ${file.name}`))
    reader.readAsDataURL(file)
  })
}

export default App
