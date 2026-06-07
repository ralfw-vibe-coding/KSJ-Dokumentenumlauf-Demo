# Dokumentenumlaufsystem

Web-App für behördliche Dokumentenumläufe mit Admin-Verwaltung, Genehmigungsphase, Kenntnisnahmephase und Neon/Postgres-Persistenz.

## Start

```bash
npm install
npm run db:migrate
npm run server
npm run dev
```

Die Anwendung läuft lokal unter `http://127.0.0.1:5173/`, die API unter `http://127.0.0.1:3001/`.

## Zugang

Nach der Migration und dem Serverstart existiert nur der initiale Admin:

- Benutzername: `admin`
- Passwort: `admin`

Weitere User werden in der Admin-Oberfläche angelegt.

## Datenbank

`.env` muss eine gültige `DATABASE_URL` enthalten. Die Migration leert die Fach-Tabellen und legt das Schema neu an. Der Admin wird beim Serverstart angelegt, falls er noch nicht existiert.
