import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { neon } from '@neondatabase/serverless'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  console.error('DATABASE_URL ist leer. Bitte .env fuellen und erneut ausfuehren.')
  process.exit(1)
}

const sql = neon(databaseUrl)
const schema = readFileSync(join(process.cwd(), 'server/schema.sql'), 'utf8')

for (const statement of schema.split(';').map((entry) => entry.trim()).filter(Boolean)) {
  await sql.query(statement)
}
console.log('Migration abgeschlossen. Die Fach-Tabellen wurden geleert; der Admin wird beim Serverstart angelegt.')
