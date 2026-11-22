# Analyse: Admin-Call zur nachträglichen Attribut-Anreicherung

**Datum:** 2026-11-21  
**Projekt:** `impl-broker-production`  
**Scope:** Nur Analyse, keine Implementierung.

---

## 0. Ausgangsfrage

Verimi liefert aktuell nur die UUID des Users, also die interne Verimi-User-ID.

Die Mitgliedsnummer soll später über eine interne REST API anhand dieser Verimi-UUID nachgeschlagen werden.

Frage:

> Ist ein Keycloak-Admin-Call gefährlich, wenn der User durch den Login indirekt die nachträgliche Ergänzung seiner Mitgliedsnummer auslöst?

---

## 1. Kurzantwort

Ja — die Sorge ist berechtigt. **Ein Admin-Call ist mächtig.**

Aber entscheidend ist nicht, ob der User den Prozess auslöst, sondern:

> Kann der User die Admin-Rechte oder den Ziel-User beeinflussen?

Ein Admin-Call aus einem vertrauenswürdigen Backend ist ein normales und legitimes Muster für:

```text
User Provisioning
Attribut-Synchronisation
Migration
Support-Tools
CI/CD
```

Das ist etwas anderes als:

```text
React → Keycloak Admin API
```

Letzteres wäre gefährlich und sollte nicht passieren.

---

## 2. User triggert Login — ist das ein Problem?

Nein, das ist zunächst kein Problem.

Vergleichbar mit einer Passwort-Zurücksetzung:

```text
User klickt "Passwort vergessen"
→ User triggert den Prozess
→ Aber das System führt die privilegierte Aktion aus
→ Nur für genau diesen verifizierten User
```

Wichtig ist die serverseitige Bindung:

```text
User löst aus:
→ "Ich bin angemeldet"

System determiniert:
→ kcSub     = claims.sub aus verifiziertem Keycloak-ID-Token
→ verimiSub = claims.verimi_sub aus verifiziertem Keycloak-ID-Token
→ realm     = aus Portal-Konfiguration
```

Der User darf **nicht** liefern:

```text
kcSub
userId
verimiSub
mitgliedsnummer
realm
API-URL
```

Diese Werte müssen aus serverseitig verifizierten Quellen stammen.

---

## 3. Das eigentliche Risiko: Confused Deputy

Gefährlich wird es hier:

```text
Browser
  ↓
POST /api/enrich
{
  "kcSub": "user-id-beliebig",
  "mitgliedsnummer": "123"
}
  ↓
Lambda mit Admin-Service-Account
  ↓
Keycloak Admin API
```

Das ist ein **Confused Deputy**-Problem:

> Der Service-Account hat Rechte.  
> Der User überredet den Service, diese Rechte für falsche Ziele zu benutzen.

Richtig ist:

```text
Keycloak ID-Token
  ↓
openid-client verifiziert Token
  ↓
claims.sub
  ↓
serverseitiges Event
  ↓
Worker
  ↓
Keycloak Admin API
```

Der User triggert nur. Er bestimmt nicht, welcher User verändert wird.

---

## 4. Admin API vs. Account API

### 4.1 Account API

```http
POST /realms/{realm}/account
```

Mit dem **Access Token des Users**.

Das ist die API, die die Keycloak Account Console benutzt.

Für die Mitgliedsnummer ist sie aber nicht ideal.

Wenn die Mitgliedsnummer über die Account API geschrieben werden soll, muss sie im User Profile für den User editierbar sein:

```json
"permissions": {
  "edit": ["user"]
}
```

Dann könnte der User direkt Keycloak aufrufen und sagen:

```json
{
  "mitgliedsnummer": "beliebiger-wert"
}
```

Das ist nicht gewollt. Die Mitgliedsnummer kommt aus dem internen System, nicht aus dem User-Input.

---

### 4.2 Admin API

```http
GET  /admin/realms/{realm}/users/{kcSub}
PUT  /admin/realms/{realm}/users/{kcSub}
```

Mit einem **Service-Account**.

Das ist die richtige API, wenn ein vertrauenswürdiges Backend einen User aktualisieren soll, den der User selbst nicht ändern darf.

User Profile Empfehlung:

```json
"permissions": {
  "view": ["admin", "user"],
  "edit": ["admin"]
}
```

Darf der User sehen, aber nicht schreiben.

---

## 5. Empfehlung: Admin API ja — aber nur aus einem isolierten Worker

Der Admin-Call sollte nicht direkt im Login-Callback passieren, sondern asynchron:

```text
User triggert Login
  ↓
Callback validiert ID-Token
  ↓
Session wird erstellt
  ↓
SQS Event:
{
  "kcSub": "...",
  "verimiSub": "...",
  "realm": "...",
  "portal": "..."
}
  ↓
Redirect zum Portal

Worker
  ↓
Interne REST API:
verimiSub → mitgliedsnummer
  ↓
Keycloak Admin API:
kcSub → Attribut ergänzen
```

### Vergleich

| Punkt | Direkt im Callback | Worker / Queue |
|---|---:|---:|
| Login blockiert bei internem API-Ausfall | Ja | Nein |
| Retry möglich | Schlecht | Gut |
| Backfill möglich | Nein | Ja |
| Security-Audit | Schwieriger | Klarer |
| Skalierbarkeit | Begrenzt | Gut |

---

## 6. Wie man den Admin-Call sicher macht

### 6.1 Kein Admin-Zugriff im Browser

Niemals:

```text
React → Keycloak Admin API
```

Sondern immer:

```text
Worker → Keycloak Admin API
```

---

### 6.2 Kein User-Input für die Ziel-ID

Der Worker darf niemals machen:

```js
const userId = event.body.userId;
```

Sondern nur Werte aus verifizierten, serverseitigen Quellen:

```js
const userId = verifiedClaims.sub;
const verimiSub = verifiedClaims.verimi_sub;
```

---

### 6.3 Eigener Service Account pro Realm

Besser:

```text
keycloak-attribute-enricher
```

mit Rechten nur für genau dieses Realm.

Schlechter:

```text
master-admin-service-account
```

mit Rechten für alles.

---

### 6.4 Admin REST nicht öffentlich exponieren

Prüfen im nginx-Setup:

```text
kc.gateway-vw.de:8443/admin/*
```

sollte blockiert sein.

Admin-Zugriffe sollten nur über den geschützten Admin-Endpunkt oder einen internen Pfad erreichbar sein:

```text
kc-admin.gateway-vw.de:8444
+ IP-Allowlist
```

Falls der Worker von AWS Lambda kommt, brauchst du stabile Egress-IPs über NAT und passende nginx-Allowlist.

---

### 6.5 Mitgliedsnummer validieren

Auch wenn die Mitgliedsnummer aus dem internen System kommt:

```text
nur erwartetes Format akzeptieren
keine Steuerzeichen
keine überlangen Strings
keine HTML/JS
```

Erst danach in Keycloak schreiben.

---

### 6.6 Audit

Im Realm Template ist bereits gesetzt:

```json
"adminEventsEnabled": true
```

Das ist gut. Der Admin-Call erscheint damit in den Keycloak Admin Events.

Zusätzlich im Worker loggen:

```text
kcSub
verimiSub
portal
realm
status
```

Aber **nicht** die Mitgliedsnummer selbst.

---

## 7. Gibt es eine Variante ganz ohne Admin-Call?

Ja. Und manchmal ist das die sauberste Lösung.

Wenn die Mitgliedsnummer **nicht in Keycloak-Token** gebraucht wird, dann speichere sie gar nicht in Keycloak.

Dann:

```text
Keycloak speichert nur verimi_sub
Portal-Backend speichert verimi_sub im Session/Cache
Bei Bedarf:
  verimi_sub → internes REST API → Mitgliedsnummer
```

Dann brauchst du keinen Admin-Call.

Das ist besonders gut, wenn die Mitgliedsnummer primär ein Fachdatum ist.

---

## 8. Wann brauchst du die Mitgliedsnummer trotzdem in Keycloak?

Dann, wenn sie gebraucht wird für:

```text
ID-Token Claim
Access-Token Claim
Keycloak Authorisierung
Account Console
Support-Sicht im Admin Console
Einheitliche User-Sicht über alle Portale
Backfill nach Verimi-Shutdown
```

Dann ist der Admin-Call aus dem Worker legitim.

---

## 9. Klare Empfehlung

### Wenn die Mitgliedsnummer nur für Anzeige im Portal gebraucht wird

```text
Keine Admin API.
Keycloak speichert nur verimi_sub.
Backend ruft internes System bei Bedarf.
```

### Wenn die Mitgliedsnummer in Keycloak / Token gebraucht wird

```text
Admin API akzeptieren.
Aber nur:
- aus Worker
- nicht aus Browser
- nicht direkt aus User-Input
- mit eigenem Service Account pro Realm
- mit strikter Bindung an claims.sub und claims.verimi_sub
- Admin API nicht öffentlich exponieren
```

Kurz gesagt:

> Der User darf den Prozess auslösen.  
> Aber er darf weder die Admin-Privilegien noch den Ziel-User bestimmen.

Wenn das erfüllt ist, ist der Admin-Call architektonisch okay.

---

## 10. Offene Punkte

1. Wird die Mitgliedsnummer später in Tokens gebraucht oder nur im Portal angezeigt?
2. Soll der Enrichment-Schritt synchron im Callback oder asynchron über SQS laufen?
3. Ist `/admin/*` auf dem öffentlichen Keycloak-Port bereits blockiert?
4. Gibt es stabile NAT-Egress-IPs für Lambda → Keycloak Admin?
5. Soll die Mitgliedsnummer bei Verlust der Mitgliedschaft wieder entfernt werden?
6. Wer ist fachlich verantwortlich, wenn das interne System die UUID nicht kennt?
