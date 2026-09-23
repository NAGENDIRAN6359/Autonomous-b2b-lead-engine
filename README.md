# Autonomous B2B Lead Nurturing & Booking Engine

An end-to-end AI automation system that captures inbound B2B leads, qualifies them using LLMs, sends hyper-personalized outreach emails, and automatically books sales calls via AI voice invitations — all without human intervention.

---

## Architecture Overview

```
Lead Source (Webflow / WordPress / Gmail)
        │
        ▼
  Webhook Handler  ──────────────────────────────────────────┐
        │                                                     │
        ▼                                                     │
  n8n Orchestration Workflow                                  │
        │                                                     │
        ├──► Lead Qualification (OpenAI GPT-4o)              │
        │         • Company size scoring                      │
        │         • Budget signal detection                   │
        │         • ICP fit score (0–100)                     │
        │                                                     │
        ├──► Personalized Email Draft (OpenAI GPT-4o)        │
        │         • Pulls enrichment data                     │
        │         • Writes subject + body                     │
        │         • Sends via Gmail API                       │
        │                                                     │
        ├──► Vapi / Retell AI Phone Call                      │
        │         • Schedules outbound AI voice call          │
        │         • Invitation to book a calendar slot        │
        │                                                     │
        ├──► Google Calendar Booking                          │
        │         • Creates available slots                   │
        │         • Sends calendar invite on confirmation     │
        │                                                     │
        └──► CRM Sync (HubSpot / GoHighLevel)                │
                  • Creates/updates contact                   │
                  • Logs all activity                         │
                  • Assigns pipeline stage                    │
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Orchestration | n8n (self-hosted or cloud) |
| AI / LLM | OpenAI GPT-4o (gpt-4o) |
| Voice AI | Vapi.ai or Retell AI |
| Email | Google Gmail API (OAuth 2.0) |
| Calendar | Google Calendar API |
| CRM | HubSpot API v3 or GoHighLevel API |
| Lead Forms | Webflow Webhooks / WordPress WPForms |
| Runtime | Node.js 20+ |
| Config | dotenv |

---

## Project Structure

```
b2b-lead-engine/
├── src/
│   ├── modules/
│   │   ├── leadQualifier.js        # OpenAI lead scoring & qualification
│   │   ├── emailDrafter.js         # OpenAI personalized email generation
│   │   ├── vapiCaller.js           # Vapi outbound AI voice call trigger
│   │   ├── calendarBooking.js      # Google Calendar slot management
│   │   └── crmSync.js              # HubSpot / GoHighLevel CRM integration
│   ├── webhooks/
│   │   └── leadWebhook.js          # Express webhook receiver (Webflow / WP)
│   └── utils/
│       ├── logger.js               # Structured logging
│       └── validate.js             # Input validation helpers
├── n8n-workflows/
│   └── lead-nurturing-workflow.json  # Full importable n8n workflow
├── prompts/
│   ├── qualification.txt           # LLM qualification system prompt
│   └── email-draft.txt             # LLM email drafting system prompt
├── config/
│   └── index.js                    # Centralised config loader
├── docs/
│   └── SETUP.md                    # Step-by-step deployment guide
├── .env.example                    # All required environment variables
├── package.json
└── index.js                        # Main entry point
```

---

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd b2b-lead-engine
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Run the Webhook Server

```bash
node index.js
```

The webhook server starts on `http://localhost:3000` by default.

### 4. Import n8n Workflow

1. Open your n8n instance
2. Go to **Workflows → Import from file**
3. Select `n8n-workflows/lead-nurturing-workflow.json`
4. Configure credentials inside n8n (see `docs/SETUP.md`)

---

## Lead Qualification Scoring

Each lead receives an ICP (Ideal Customer Profile) score from 0–100:

| Score Range | Status | Action |
|---|---|---|
| 80–100 | Hot Lead 🔥 | Immediate email + AI call |
| 50–79 | Warm Lead 🟡 | Email only, follow-up in 48h |
| 0–49 | Cold Lead ❄️ | Add to nurture sequence |

Scoring factors:
- **Company size** — employee count signals
- **Budget indicators** — keywords in form responses
- **Role/seniority** — decision-maker detection
- **Industry fit** — matches your target verticals
- **Urgency signals** — timeline mentioned in message

---

## Email Personalization

The GPT-4o email drafter uses:
- Lead's name, company, role
- Their specific pain point from the form
- Industry-specific social proof
- A direct CTA to book a call (Calendly / Google Calendar link)

---

## AI Voice Call Flow (Vapi)

1. Lead submits form → qualifies as Hot
2. Vapi schedules outbound call within configured delay (default: 15 min)
3. AI agent introduces your company, references their inquiry
4. Offers 2–3 time slots and invites them to confirm
5. On confirmation → Google Calendar invite created + CRM updated

---

## CRM Pipeline Stages

| Stage | Trigger |
|---|---|
| `New Lead` | Form submission received |
| `Qualified` | ICP score ≥ 50 |
| `Outreach Sent` | Email dispatched |
| `Call Scheduled` | AI call booked |
| `Meeting Booked` | Calendar invite confirmed |
| `Disqualified` | ICP score < 50 |

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `VAPI_API_KEY` | Vapi.ai API key |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `HUBSPOT_API_KEY` | HubSpot private app token |
| `GHL_API_KEY` | GoHighLevel API key |
| `WEBHOOK_SECRET` | Shared secret for webhook validation |

---

## License

MIT

---

## Critical Limitations & How This System Addresses Them

### 1. The Email Deliverability Trap

**The risk:** Sending thousands of AI-generated emails from a single company domain gets it blacklisted by Google and Microsoft within days. One spam complaint spike can permanently damage your domain's sending reputation — and that damage is very hard to reverse.

**What's implemented: `src/modules/emailRotationManager.js`**

| Mechanism | Detail |
|---|---|
| Sender pool | Multiple accounts across secondary lookalike domains (e.g. `company-sales.com`, `company-hq.com`) |
| Warmup schedule | New accounts start at 5 emails/day and ramp to 250 over 40 days following the industry-standard curve |
| Round-robin rotation | Most-warmed sender is preferred; among equal tiers, least-recently-used is picked (spreads reputation load) |
| Auto-suspension | Any sender exceeding 5% bounce rate or 0.1% complaint rate is automatically suspended |
| CAN-SPAM compliance | Every outbound email includes `List-Unsubscribe` and `List-Unsubscribe-Post: One-Click` headers |
| Disk-persisted state | Send counts, bounce counts, and warmup dates survive server restarts |

**What you still need to do manually:**
- Purchase secondary domains via Namecheap/GoDaddy (keep them close to your brand — `yourco-sales.com`, `yourco-team.com`)
- Set up SPF, DKIM, and DMARC DNS records on each domain before sending anything
- Create Google Workspace accounts on each domain and complete the OAuth flow (`/auth/google`) for each
- Register each sender account using `emailRotationManager.registerSender()`

**Registering a sender account (run once per account):**
```js
const { registerSender } = require('./src/modules/emailRotationManager');

registerSender({
  id: 'sales-1',
  email: 'alex@yourco-sales.com',
  displayName: 'Alex from YourCo',
  domain: 'yourco-sales.com',
  refreshToken: 'ya29.xxx...',         // from /auth/google OAuth flow
  warmupStartDate: '2026-09-22',       // today — warmup starts now
});
```

---

### 2. The AI Voice Call Hesitation

**The risk:** Decision-makers hang up within 2 seconds when they detect a robocall — caused by processing silence before the AI speaks, an unnatural opener, or a script that reads like a machine wrote it.

**What's implemented: `src/modules/vapiCaller.js`**

| Mechanism | Detail |
|---|---|
| `firstMessage` instant opener | Vapi speaks this phrase on connect *before* any LLM turn — eliminates the 2-second silence gap entirely |
| Human-pattern opener | `"Hey [name], it's [rep] — is this a good time for literally 30 seconds?"` — mirrors exactly how a real SDR opens |
| 5 call guards | Score ≥ 75, completenessScore ≥ 55, DM likelihood not `low`, phone present, no disqualification flag |
| Business hours enforcement | Calls are never placed before 9 AM or after 5 PM UTC, never on weekends — auto-pushes to next valid slot |
| 90-second hard cap | `maxDurationSeconds: 90` — the assistant winds down gracefully if no booking by then |
| ElevenLabs voice tuning | `stability: 0.45` (lower = more natural variation, less robotic monotone), `style: 0.3` (subtle, not over-performed) |
| Deepgram Nova-2 transcriber | ~200ms STT latency — fastest available in Vapi; `endpointing: 200ms` |
| Voicemail detection | AMD enabled — leaves a 10-second human message and hangs up rather than reciting the pitch to a mailbox |
| Script hard rules | Explicit prohibitions in the system prompt: no feature lists, no buzzwords, no more than one question at a time |

**Call flow the AI follows:**
```
Connect → firstMessage (instant) → wait for response
  ├─ "Yes/go ahead" → one-sentence hook + offer two time slots
  │     ├─ Confirms time → "Sending invite now" → end
  │     └─ Asks for more info → one sentence max → redirect to slot
  ├─ "I'm busy" → "I'll text you a link" → end
  └─ "Not interested" → "No problem at all" → end immediately
```

---

### 3. LLM Hallucinations in Qualification

**The risk:** An LLM can confidently score a student looking for a job, a bot submission, or a competitor doing research as a high-value hot lead — triggering expensive Vapi calls and damaging domain reputation with irrelevant emails.

**What's implemented: `src/modules/leadQualifier.js` — three-layer defence**

**Layer 1 — Pre-LLM Hard Gates** (synchronous, zero API cost — runs before any OpenAI call)

| Gate | What it catches |
|---|---|
| Bot/disposable email patterns | `test@`, `admin@`, `noreply@`, plus-aliased emails, numeric-prefix addresses |
| Free email domains | 23 consumer providers blocked (gmail, yahoo, hotmail, outlook, icloud, protonmail, etc.) with -20 score penalty |
| Job-seeker keywords | 19 phrases across name and message fields: "resume", "cv attached", "looking for a job", "university project", etc. |
| Short message gate | Messages under 20 characters get -15 score penalty — not enough signal to qualify meaningfully |

**Layer 2 — Structured LLM Output with `response_format: json_object`**

- OpenAI's JSON mode guarantees valid JSON output — no markdown fences, no prose mixed in
- The prompt includes a `completenessScore` (0–100) requirement: the model must assess how much usable data the lead actually provided
- Mandatory disqualification triggers are embedded directly in the system prompt (job application, no company context, generic greeting)

**Layer 3 — Post-LLM Consistency Checks** (code always wins over LLM)

| Check | Effect |
|---|---|
| Score + penalty applied | Gate penalties subtracted from LLM score before tier assignment |
| `completenessScore < 60` blocks `hot` tier | A high score on sparse data is capped to `warm` — prevents hallucinated hot leads |
| Deterministic tier assignment | Code re-derives `tier` from numeric `score` — LLM's `tier` field is discarded |
| `disqualificationFlag` override | If the LLM raises its own flag, tier is forced to `cold` and score capped at 30 |
| Schema field-by-field validation | Every field validated for type and range; invalid values are corrected rather than crashing |

**Result — what the qualifier now rejects automatically before spending any money:**

```
❌ john.doe@gmail.com          → GATE_FREE_EMAIL_DOMAIN (-20 pts)
❌ test@example.com            → GATE_BOT_EMAIL
❌ "Hi, I'm looking for a job" → GATE_JOB_SEEKER
❌ "Need help"                 → SOFT_SHORT_MESSAGE (-15 pts)
❌ Score 85 but completeness 40 → Downgraded warm (not hot)
```

---

### Summary: What each module now protects

```
leadQualifier.js      →  Stops bad leads before they cost money
emailRotationManager  →  Protects sending domains from blacklisting
vapiCaller.js         →  Prevents instant hang-ups from robocall detection
emailDrafter.js       →  Routes sends through the rotation pool (not primary domain)
```
