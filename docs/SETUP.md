# Setup & Deployment Guide

Step-by-step instructions for deploying the B2B Lead Nurturing & Booking Engine from scratch.

---

## Prerequisites

- Node.js 20+
- A Google Cloud project with Gmail API and Calendar API enabled
- An OpenAI account with API access (GPT-4o)
- A Vapi.ai account with an assistant configured
- Either a HubSpot or GoHighLevel account
- A Webflow or WordPress site with a contact form (optional — direct POST also works)

---

## Step 1 — Install Dependencies

```bash
cd b2b-lead-engine
npm install
```

---

## Step 2 — Google OAuth Setup (Gmail + Calendar)

### 2a. Create Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g., "Lead Engine")
3. Enable these APIs:
   - **Gmail API** — Search "Gmail API" → Enable
   - **Google Calendar API** — Search "Google Calendar API" → Enable

### 2b. Create OAuth 2.0 Credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: "Lead Engine"
5. Authorized redirect URIs: `http://localhost:3000/auth/google/callback`
6. Save — copy the **Client ID** and **Client Secret** into `.env`

### 2c. Get Your Refresh Token

1. Start the server: `node index.js`
2. Open your browser: `http://localhost:3000/auth/google`
3. Complete the Google consent flow (grant Gmail + Calendar permissions)
4. Copy the **refresh token** shown on the callback page
5. Add it to `.env` as `GOOGLE_REFRESH_TOKEN`
6. Restart the server

> The refresh token is long-lived. You only need to do this once unless you revoke access.

---

## Step 3 — OpenAI API Key

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create a new secret key
3. Add it to `.env` as `OPENAI_API_KEY`
4. Ensure you have access to `gpt-4o` (requires a paid account with GPT-4 access)

---

## Step 4 — Vapi Setup

### 4a. Create a Vapi Account & Assistant

1. Sign up at [vapi.ai](https://vapi.ai)
2. Go to **Assistants → Create Assistant**
3. Configure your assistant:
   - **Name**: "Lead Outreach Agent"
   - **System Prompt**: Use the template below
   - **Voice**: Choose a natural-sounding voice (ElevenLabs integration recommended)
   - **End Call Phrases**: "goodbye", "thank you, bye", "have a good day"

### 4b. Vapi Assistant System Prompt Template

```
You are a friendly, professional sales development representative calling on behalf of {{companyName}}.

You are calling {{leadFirstName}} from {{leadCompany}}.

They recently reached out about: {{primaryPainPoint}}.

Your goal:
1. Introduce yourself warmly (first name only)
2. Reference their specific inquiry naturally
3. Offer to schedule a 30-minute discovery call with the team
4. If they're interested, confirm a time and mention they'll receive a calendar invite
5. If they're busy, offer to send a calendar link by text: {{bookingUrl}}

Keep the call under 90 seconds. Be conversational, not scripted.
Never read bullet points out loud. Speak naturally.
If they say they're not interested, thank them and end politely.
```

### 4c. Get Your Vapi Keys

1. Copy your **API Key** from Vapi dashboard → Settings → API Keys
2. Copy the **Assistant ID** from your assistant's settings page
3. Go to **Phone Numbers → Add Phone Number** — get a phone number for outbound calls
4. Add all three to `.env`:
   - `VAPI_API_KEY`
   - `VAPI_ASSISTANT_ID`
   - `VAPI_FROM_PHONE_NUMBER` (E.164 format: +12025551234)

---

## Step 5 — CRM Setup

### Option A: HubSpot

1. Go to **Settings → Integrations → Private Apps**
2. Create a Private App with these scopes:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
   - `crm.objects.deals.read`
   - `crm.objects.deals.write`
   - `crm.objects.notes.write`
3. Copy the token into `.env` as `HUBSPOT_API_KEY`
4. In HubSpot: **Settings → Properties → Contact Properties**
   - Create custom properties: `lead_score`, `lead_tier`, `lead_message`, `qualification_reasoning`
5. Find your pipeline ID: **CRM → Sales → Pipelines** — URL contains the pipeline ID
6. Set `CRM_PROVIDER=hubspot` in `.env`

### Option B: GoHighLevel

1. Go to **Settings → API Keys** in your GHL sub-account
2. Copy the API key into `.env` as `GHL_API_KEY`
3. Find your Location ID in the URL when inside your sub-account
4. Set up a pipeline in GHL and copy the Pipeline ID from Settings → Pipelines
5. Set `CRM_PROVIDER=gohighlevel` in `.env`

---

## Step 6 — Configure Webflow Webhook

1. In Webflow: **Project Settings → Integrations → Webhooks**
2. Add a new webhook:
   - **Trigger**: Form Submission
   - **URL**: `https://your-domain.com/webhooks/lead?source=webflow`
   - **Secret**: Set a secret and add it to `.env` as `WEBHOOK_SECRET`

---

## Step 7 — Configure WordPress Webhook

### Using WPForms

1. Install WPForms + Webhooks addon
2. Edit your form → **Settings → Webhooks**
3. Add webhook:
   - **URL**: `https://your-domain.com/webhooks/lead?source=wordpress`
   - **Method**: POST
   - **Format**: JSON
4. Map fields to standard names (email, name, company, phone, message)

### Using Gravity Forms

1. Install Gravity Forms + Webhooks addon
2. Form Settings → Webhooks → Add New
3. URL: `https://your-domain.com/webhooks/lead?source=wordpress`
4. Request format: JSON

---

## Step 8 — Import n8n Workflow (Optional)

If you prefer to orchestrate via n8n instead of the Node.js server:

1. Open your n8n instance
2. **Workflows → Import from File**
3. Select `n8n-workflows/lead-nurturing-workflow.json`
4. Configure credentials:
   - Add **Gmail OAuth2** credential (Client ID + Secret + refresh token)
   - Add **HTTP Request Auth** for OpenAI (Header: `Authorization: Bearer sk-...`)
   - Add **HTTP Request Auth** for Vapi (Header: `Authorization: Bearer ...`)
5. Set environment variables in n8n's Settings or use n8n credential stores
6. Activate the workflow
7. Copy the webhook URL shown in the "Lead Intake Webhook" node

---

## Step 9 — Run the Server

### Development

```bash
npm run dev     # Node.js --watch mode (auto-restarts on file changes)
```

### Production

```bash
# With PM2 (recommended)
npm install -g pm2
pm2 start index.js --name "lead-engine"
pm2 save
pm2 startup

# Or directly
NODE_ENV=production node index.js
```

---

## Step 10 — Test the Pipeline

Send a test lead via curl:

```bash
curl -X POST http://localhost:3000/webhooks/lead \
  -H "Content-Type: application/json" \
  -d '{
    "first_name": "Sarah",
    "last_name": "Chen",
    "email": "sarah.chen@acmecorp.io",
    "phone": "+14155551234",
    "company": "Acme Corp",
    "job_title": "VP of Marketing",
    "company_size": "200-500 employees",
    "budget": "$5,000/month",
    "industry": "SaaS",
    "message": "We are struggling to convert trial users into paid customers and need help building an automated nurture sequence.",
    "website": "https://acmecorp.io",
    "_source": "direct"
  }'
```

Expected response:
```json
{ "status": "accepted", "message": "Lead received and processing" }
```

Check server logs — you should see the full pipeline run within 10–20 seconds.

---

## Monitoring & Logs

- **Development**: colorized console output
- **Production**: JSON-structured log lines (pipe to your log aggregator)
- **n8n**: Check Executions tab in n8n UI for visual pipeline traces

---

## Environment Variable Reference

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | OpenAI secret key |
| `OPENAI_MODEL` | ✅ | Model name (default: `gpt-4o`) |
| `VAPI_API_KEY` | ✅ for calls | Vapi API key |
| `VAPI_ASSISTANT_ID` | ✅ for calls | Vapi assistant ID |
| `VAPI_FROM_PHONE_NUMBER` | ✅ for calls | Outbound phone number (E.164) |
| `VAPI_CALL_DELAY_MINUTES` | — | Delay before placing call (default: 15) |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | ✅ | Long-lived OAuth refresh token |
| `GMAIL_SENDER_ADDRESS` | ✅ | Email address to send from |
| `GMAIL_SENDER_NAME` | ✅ | Display name for sent emails |
| `GOOGLE_CALENDAR_ID` | — | Calendar ID (default: `primary`) |
| `BOOKING_PAGE_URL` | ✅ | Calendly or booking page URL |
| `HUBSPOT_API_KEY` | If HubSpot | HubSpot private app token |
| `GHL_API_KEY` | If GHL | GoHighLevel API key |
| `GHL_LOCATION_ID` | If GHL | GHL sub-account location ID |
| `CRM_PROVIDER` | ✅ | `hubspot` or `gohighlevel` |
| `WEBHOOK_SECRET` | Recommended | HMAC secret for webhook verification |
| `QUALIFICATION_HOT_THRESHOLD` | — | Min score for hot tier (default: 80) |
| `QUALIFICATION_WARM_THRESHOLD` | — | Min score for warm tier (default: 50) |
| `COMPANY_NAME` | ✅ | Your company name (used in emails/calls) |
| `COMPANY_VALUE_PROP` | ✅ | One-line value proposition |
| `TARGET_INDUSTRIES` | — | Comma-separated target verticals |

---

## Troubleshooting

**"Missing required environment variables" on startup**
→ Check `.env` exists and has all required keys. Run `node -e "require('dotenv').config(); console.log(process.env.OPENAI_API_KEY)"` to verify loading.

**Gmail sending fails with 401**
→ Refresh token has expired or was revoked. Visit `http://localhost:3000/auth/google` to re-authorize.

**Vapi call not placed**
→ Check `VAPI_FROM_PHONE_NUMBER` is in E.164 format. Ensure the assistant ID is correct. Check Vapi dashboard logs.

**HubSpot 409 Conflict**
→ Normal — contact already exists. The engine will automatically update instead.

**LLM returns non-JSON**
→ Rare but can happen. The engine logs the raw response. Check `OPENAI_MODEL` is set to `gpt-4o` or newer.

**n8n workflow not triggering**
→ Ensure the workflow is activated (toggle in top-right). Check the webhook URL matches what you're POSTing to.
