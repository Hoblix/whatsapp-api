# WhatsApp Dashboard — AWS Migration Plan

## Overview

Migrate from Cloudflare Workers/Pages + Supabase to AWS (ECS Fargate + S3/CloudFront + RDS).
Two separate GitHub repos, CI/CD via GitHub Actions.

---

## Architecture

```
                    +-----------------------+
                    |   Route 53 / DNS      |
                    +-----------+-----------+
                                |
                    +-----------+-----------+
                    |   CloudFront (CDN)    |
                    |   whatsapp.hoblix.com |
                    +-----------+-----------+
                                |
              +-----------------+-----------------+
              |                                   |
    +---------+----------+             +----------+---------+
    | S3 Bucket          |             | ALB (Load Balancer)|
    | (Frontend SPA)     |             | api.hoblix.com     |
    | Static React build |             +----------+---------+
    +--------------------+                        |
                                       +----------+---------+
                                       | ECS Fargate        |
                                       | (API Container)    |
                                       | Node.js + Hono     |
                                       +----------+---------+
                                                  |
                                       +----------+---------+
                                       | RDS PostgreSQL     |
                                       | (via RDS Proxy)    |
                                       +--------------------+
                                                  |
                                       +----------+---------+
                                       | EventBridge        |
                                       | Scheduler          |
                                       | (Booking Reminders)|
                                       +--------------------+

    WebSocket: API Gateway WebSocket API + Lambda + DynamoDB
    Secrets:   AWS Secrets Manager
    CI/CD:     GitHub Actions → ECR → ECS / S3
```

---

## Repo Structure

### Repo 1: `sachin-nex/whatsapp-api`

```
whatsapp-api/
├── src/
│   ├── index.ts                 # Hono standalone Node.js server
│   ├── env.ts                   # Environment config (process.env)
│   ├── routes/
│   │   ├── webhook.ts           # Meta webhook handler
│   │   ├── auth.ts              # OTP send/verify/logout
│   │   ├── send.ts              # Send messages (text/media/template)
│   │   ├── conversations.ts     # Conversation CRUD
│   │   ├── templates.ts         # Template management
│   │   ├── automations.ts       # Automation workflows
│   │   ├── automationEngine.ts  # Automation execution engine
│   │   ├── flowEndpoint.ts      # WhatsApp Flows encrypted endpoint
│   │   ├── flowHandlers/
│   │   │   └── reschedule.ts    # Reschedule callback flow handler
│   │   ├── notifications.ts     # Push notifications
│   │   └── ... (other routes)
│   ├── lib/
│   │   ├── db.ts                # PostgreSQL connection (pg pool, no Hyperdrive)
│   │   ├── schema/              # Drizzle ORM schema files
│   │   ├── flowCrypto.ts        # RSA/AES encryption for Flows
│   │   └── ...
│   ├── jobs/
│   │   └── missedCallNotifier.ts
│   └── ws/
│       └── websocketManager.ts  # WebSocket via API Gateway (replaces DO)
├── drizzle/                     # SQL migration files
├── infra/
│   └── cloudformation.yml       # AWS infrastructure template
├── Dockerfile
├── .github/
│   └── workflows/
│       └── deploy.yml           # GitHub Actions → ECR → ECS
├── package.json
├── tsconfig.json
└── .env.example
```

### Repo 2: `sachin-nex/whatsapp-dashboard`

```
whatsapp-dashboard/
├── src/
│   ├── components/              # All React components (unchanged)
│   ├── hooks/                   # React Query hooks (unchanged)
│   ├── pages/                   # All pages (unchanged)
│   ├── lib/                     # Utilities
│   └── App.tsx
├── public/                      # Static assets
├── vite.config.ts               # Build config
├── .github/
│   └── workflows/
│       └── deploy.yml           # GitHub Actions → S3 + CloudFront invalidation
├── package.json
├── tsconfig.json
└── .env.example                 # VITE_API_URL=https://api.hoblix.com
```

---

## Pre-requisites Checklist

### From you (before migration starts)

- [ ] AWS Account ID: `153758676366` (confirmed)
- [ ] AWS Region: `ap-south-1` (Mumbai) (confirmed)
- [ ] IAM Access Key for GitHub Actions
      - IAM → Users → Create user → "github-deploy"
      - Use case: "Third-party service"
      - Attach policy: `AdministratorAccess` (or custom — see below)
      - Create access key → copy Access Key ID + Secret
- [ ] Share the Access Key ID and Secret Access Key
- [ ] Domain DNS: confirm where `hoblix.com` DNS is managed
- [ ] Subdomain plan:
      - `api.hoblix.com` → API (ALB/ECS)
      - `whatsapp.hoblix.com` → Dashboard (CloudFront/S3)

### Custom IAM Policy (if not using AdministratorAccess)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:*",
        "ecs:*",
        "ec2:Describe*",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "elasticloadbalancing:*",
        "rds:*",
        "s3:*",
        "cloudfront:*",
        "secretsmanager:*",
        "ssm:*",
        "iam:PassRole",
        "iam:CreateServiceLinkedRole",
        "logs:*",
        "events:*",
        "scheduler:*",
        "apigateway:*",
        "lambda:*",
        "dynamodb:*",
        "acm:*",
        "route53:*"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## Migration Phases

### Phase 1: AWS Infrastructure Setup (Day 1)

**What:** Provision all AWS resources via CloudFormation.

**Resources created:**
1. **VPC** — private subnets for RDS, public for ALB
2. **RDS PostgreSQL** — db.t3.micro, same version as Supabase
3. **RDS Proxy** — connection pooling for ECS tasks
4. **ECR Repository** — Docker image registry for API
5. **ECS Cluster + Fargate Service** — runs the API container
6. **ALB** — routes `api.hoblix.com` to ECS
7. **S3 Bucket** — hosts frontend static files
8. **CloudFront Distribution** — CDN for S3, custom domain `whatsapp.hoblix.com`
9. **ACM Certificates** — HTTPS for both subdomains
10. **Secrets Manager** — all WhatsApp/Notion/VAPID secrets
11. **API Gateway WebSocket API** — replaces Durable Object WebSocket hub
12. **DynamoDB Table** — stores active WebSocket connection IDs
13. **EventBridge Scheduler** — replaces Durable Object booking reminders
14. **Security Groups** — ALB ↔ ECS ↔ RDS network rules

**How:** Run CloudFormation template from AWS Console.

```bash
# Or via CLI if preferred:
aws cloudformation create-stack \
  --stack-name hoblix-whatsapp \
  --template-body file://infra/cloudformation.yml \
  --parameters ParameterKey=DBPassword,ParameterValue=<password> \
  --capabilities CAPABILITY_IAM \
  --region ap-south-1
```

**Validation:**
- [ ] RDS instance is running and accessible from ECS security group
- [ ] ECR repository exists
- [ ] ECS cluster is created
- [ ] S3 bucket is created with static website hosting
- [ ] CloudFront distribution is deployed
- [ ] ACM certificates are validated

---

### Phase 2: Database Migration (Day 1-2)

**What:** Move all data from Supabase PostgreSQL to RDS.

**Steps:**

1. **Export from Supabase:**
```bash
pg_dump "postgresql://postgres:<password>@db.llyiwnzhvvaemuprjqww.supabase.co:5432/postgres" \
  --no-owner --no-acl --clean --if-exists \
  -F custom -f supabase_backup.dump
```

2. **Import to RDS:**
```bash
pg_restore -h <rds-endpoint>.ap-south-1.rds.amazonaws.com \
  -U postgres -d postgres \
  --no-owner --no-acl \
  supabase_backup.dump
```

3. **Verify row counts:**
```sql
SELECT 'conversations' as tbl, count(*) FROM conversations
UNION ALL SELECT 'messages', count(*) FROM messages
UNION ALL SELECT 'allowed_users', count(*) FROM allowed_users
UNION ALL SELECT 'callback_bookings', count(*) FROM callback_bookings
UNION ALL SELECT 'flow_definitions', count(*) FROM flow_definitions
UNION ALL SELECT 'automation_workflows', count(*) FROM automation_workflows
-- ... all tables
```

4. **Test connectivity:**
   - Point current Cloudflare Workers to RDS temporarily
   - Verify dashboard still works
   - If OK, proceed; if not, rollback to Supabase

**Tables being migrated:**
- `conversations`, `messages`
- `allowed_users`, `auth_sessions`, `otp_codes`
- `api_keys`, `ip_allowlist`
- `flow_tenants`, `flow_definitions`, `flow_screens`
- `flow_routing_rules`, `flow_submissions`, `flow_rsa_keys`
- `flow_integrations`, `flow_integration_mappings`
- `flow_analytics_events`
- `automation_workflows`, `automation_nodes`
- `automation_executions`, `automation_condition_logs`
- `callback_bookings`, `template_media`
- `missed_call_notifications`
- `push_subscriptions`, `backups`

**Rollback plan:** Keep Supabase running for 7 days after migration. If issues, switch `DATABASE_URL` back.

---

### Phase 3: Backend Code Migration (Day 2-3)

**What:** Adapt the Hono API to run on Node.js (remove Cloudflare-specific code).

**Changes required:**

| Remove (Cloudflare) | Replace with (AWS) |
|---|---|
| `wrangler.toml` | `Dockerfile` + `docker-compose.yml` |
| `env.HYPERDRIVE.connectionString` | `process.env.DATABASE_URL` (direct pg pool) |
| `env.WEBHOOK_HUB` (Durable Object) | API Gateway WebSocket API + DynamoDB |
| `env.BOOKING_REMINDER` (Durable Object) | EventBridge Scheduler + Lambda |
| `c.executionCtx.waitUntil(...)` | Fire-and-forget async (Node.js keeps running) |
| `crypto.subtle` (Web Crypto) | Node.js `crypto` module |
| Hono Workers adapter | Hono Node.js adapter (`@hono/node-server`) |

**Dockerfile:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

**Key code changes:**

```typescript
// Before (Cloudflare Workers)
import { Hono } from "hono";
const app = new Hono<HonoEnv>();
export default { fetch: app.fetch };

// After (Node.js)
import { Hono } from "hono";
import { serve } from "@hono/node-server";
const app = new Hono();
serve({ fetch: app.fetch, port: 3000 });
```

```typescript
// Before (Cloudflare env bindings)
const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;

// After (process.env)
const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!;
```

```typescript
// Before (Hyperdrive connection)
export function getDbUrl(env) {
  return env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
}

// After (direct connection string)
export function getDbUrl() {
  return process.env.DATABASE_URL!;
}
```

**Validation:**
- [ ] API starts locally via `docker compose up`
- [ ] All routes respond (health check, templates, conversations, etc.)
- [ ] WhatsApp webhook verification passes
- [ ] OTP send/verify works
- [ ] Template sends work
- [ ] Flow endpoint encryption/decryption works

---

### Phase 4: Frontend Migration (Day 3)

**What:** Make the React dashboard a standalone SPA pointing to the API URL.

**Changes required:**

1. **Environment variable for API URL:**
```typescript
// vite.config.ts — proxy removed, API URL from env
// .env.production
VITE_API_URL=https://api.hoblix.com
```

2. **API client base URL:**
```typescript
// Before: relative paths (same origin)
fetch("/api/conversations")

// After: use configured base URL
fetch(`${import.meta.env.VITE_API_URL}/api/conversations`)
```

3. **Remove Cloudflare-specific:**
   - Remove `functions/` directory (Pages Functions proxy)
   - Remove `_headers` (use CloudFront response headers policy)
   - Update service worker for S3 hosting

4. **CORS on API:**
   - API allows `https://whatsapp.hoblix.com` origin
   - Credentials: include (for auth cookies)
   - Cookie `Domain=.hoblix.com` so it's shared across subdomains

5. **WebSocket URL:**
```typescript
// Before
const ws = new WebSocket(`wss://${window.location.host}/api/ws`)

// After
const wsUrl = import.meta.env.VITE_WS_URL || "wss://api.hoblix.com/ws"
const ws = new WebSocket(wsUrl)
```

**Build & Deploy:**
```bash
pnpm build                          # → dist/
aws s3 sync dist/ s3://hoblix-whatsapp-dashboard/
aws cloudfront create-invalidation --distribution-id XXXXX --paths "/*"
```

**Validation:**
- [ ] Dashboard loads from CloudFront URL
- [ ] Login (OTP) works cross-origin
- [ ] Conversations load
- [ ] Template send works
- [ ] WebSocket connects and receives real-time updates

---

### Phase 5: Durable Object Replacements (Day 3-4)

#### 5a: WebSocket Hub → API Gateway WebSocket API

**Current:** `WebhookHub` Durable Object holds WebSocket connections.
**New:** API Gateway WebSocket API + Lambda + DynamoDB.

```
Dashboard connects → API Gateway WebSocket → $connect Lambda
    → stores connectionId in DynamoDB

Webhook fires → API → broadcasts to all connections via:
    → scan DynamoDB for connectionIds
    → ApiGatewayManagementApi.postToConnection(id, data)

Dashboard disconnects → $disconnect Lambda
    → removes connectionId from DynamoDB
```

**DynamoDB table:** `hoblix-ws-connections`
- Partition key: `connectionId` (string)
- TTL: `ttl` (auto-cleanup stale connections)

#### 5b: Booking Reminder → EventBridge Scheduler

**Current:** `BookingReminder` Durable Object with alarms.
**New:** EventBridge Scheduler (one-time schedule per booking).

```
Booking created/rescheduled
    → Create EventBridge one-time schedule:
      Name: "reminder-{phone}"
      ScheduleExpression: "at(2026-04-18T09:30:00)"  # 30min before slot IST→UTC
      Target: Lambda function
      Input: { phone, name, date, slot, slotLabel }
    → If rescheduled: delete old schedule + create new

Lambda fires at scheduled time
    → Sends callback_reminder template via WhatsApp API
```

**Validation:**
- [ ] WebSocket connects from dashboard
- [ ] Inbound message pushes to dashboard in real-time
- [ ] Booking reminder fires at correct time
- [ ] Reschedule overwrites the old reminder

---

### Phase 6: DNS Cutover (Day 4)

**Steps:**

1. **Verify everything works** on AWS URLs (ALB, CloudFront)
2. **Update Meta webhook URL:**
   - WhatsApp Business Manager → Configuration → Webhook
   - Change from `https://whatsapp-api.shy-sun-a5ec.workers.dev/api/webhook`
   - To `https://api.hoblix.com/api/webhook`
   - Wait for verification ping
3. **DNS changes:**
   - `api.hoblix.com` → CNAME to ALB DNS name
   - `whatsapp.hoblix.com` → CNAME to CloudFront distribution
4. **Update CORS origins** in API config
5. **Update cookie domain** to `.hoblix.com`
6. **Test end-to-end** with real WhatsApp messages

**Rollback plan:** DNS TTL set to 60s before cutover. If issues, point back to Cloudflare in <2 min.

---

### Phase 7: Cleanup (Day 5+)

- [ ] Decommission Supabase (after 7-day parallel run)
- [ ] Delete Cloudflare Workers deployment
- [ ] Delete Cloudflare Pages deployment
- [ ] Remove Durable Object bindings
- [ ] Revoke old Cloudflare API tokens
- [ ] Update any hardcoded `whatsapp-api.shy-sun-a5ec.workers.dev` URLs
- [ ] Update Make.com webhook URL to `api.hoblix.com`
- [ ] Update Notion flow endpoint URL
- [ ] Update WhatsApp Flow endpoint URL in Meta Business Suite

---

## GitHub Actions — CI/CD

### API Deploy (`whatsapp-api/.github/workflows/deploy.yml`)

```yaml
name: Deploy API
on:
  push:
    branches: [main]

env:
  AWS_REGION: ap-south-1
  ECR_REPOSITORY: hoblix-whatsapp-api
  ECS_CLUSTER: hoblix-cluster
  ECS_SERVICE: whatsapp-api

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build & push image
        run: |
          docker build -t ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }} .
          docker push ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }}

      - name: Update ECS service
        run: |
          aws ecs update-service \
            --cluster ${{ env.ECS_CLUSTER }} \
            --service ${{ env.ECS_SERVICE }} \
            --force-new-deployment
```

### Dashboard Deploy (`whatsapp-dashboard/.github/workflows/deploy.yml`)

```yaml
name: Deploy Dashboard
on:
  push:
    branches: [main]

env:
  AWS_REGION: ap-south-1
  S3_BUCKET: hoblix-whatsapp-dashboard
  CLOUDFRONT_DIST_ID: EXXXXXXXXXXXXX

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install & Build
        run: |
          npm install -g pnpm
          pnpm install
          pnpm build
        env:
          VITE_API_URL: https://api.hoblix.com

      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Deploy to S3
        run: aws s3 sync dist/public/ s3://${{ env.S3_BUCKET }}/ --delete

      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ env.CLOUDFRONT_DIST_ID }} \
            --paths "/*"
```

---

## GitHub Secrets Required

Set these in both repos → Settings → Secrets → Actions:

| Secret | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | From IAM user "github-deploy" |
| `AWS_SECRET_ACCESS_KEY` | From IAM user "github-deploy" |

---

## Secrets Manager — Environment Variables

Store in AWS Secrets Manager (one secret JSON):

```json
{
  "DATABASE_URL": "postgresql://postgres:xxx@hoblix-rds.xxx.ap-south-1.rds.amazonaws.com:5432/postgres",
  "WHATSAPP_ACCESS_TOKEN": "EAAx...",
  "WHATSAPP_PHONE_NUMBER_ID": "...",
  "WHATSAPP_WABA_ID": "...",
  "WHATSAPP_VERIFY_TOKEN": "...",
  "WHATSAPP_APP_SECRET": "...",
  "SUPER_ADMIN_PHONE": "...",
  "OTP_TEMPLATE_NAME": "otp_login",
  "OTP_TEMPLATE_LANG": "en",
  "MAKE_WEBHOOK_SECRET": "27ffbacd...",
  "VAPID_PUBLIC_KEY": "...",
  "VAPID_PRIVATE_KEY": "...",
  "VAPID_SUBJECT": "...",
  "BACKUP_ENCRYPTION_KEY": "...",
  "META_ADS_ACCESS_TOKEN": "...",
  "META_AD_ACCOUNT_ID": "..."
}
```

ECS task definition references this secret; values injected as env vars at container start.

---

## Cost Estimate (Monthly)

| Service | Spec | Cost |
|---|---|---|
| RDS PostgreSQL | db.t3.micro, 20GB | ~$15 |
| ECS Fargate | 0.25 vCPU, 0.5GB, 1 task | ~$10 |
| ALB | 1 LB | ~$16 |
| S3 | <1GB static | ~$0.03 |
| CloudFront | <10GB transfer | ~$1 |
| ECR | <1GB images | ~$0.10 |
| Secrets Manager | 1 secret | ~$0.40 |
| API Gateway WS | <1M connections | ~$1 |
| DynamoDB | on-demand, minimal | ~$1 |
| EventBridge | <1000 schedules | Free |
| **Total** | | **~$45/month** |

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Data loss during migration | pg_dump before migration; keep Supabase 7 days |
| Webhook downtime | Update Meta webhook URL, <5 min propagation |
| DNS propagation delay | Set TTL to 60s 24h before cutover |
| Cookie cross-domain issues | Set Domain=.hoblix.com on auth cookies |
| Cold start latency (if Lambda) | Using Fargate instead (always warm) |
| WebSocket reconnection gap | Auto-reconnect with backoff already built |
| Pending DO alarms lost | Backfill from callback_bookings → EventBridge |

---

## Post-Migration Checklist

- [ ] All API routes responding
- [ ] WhatsApp webhook receiving messages
- [ ] OTP send/verify working
- [ ] Template creation + send working
- [ ] Reschedule flow working (encryption/decryption)
- [ ] Notion upsert on reschedule working
- [ ] Booking reminder fires at correct time
- [ ] Missed-call webhook from Make working
- [ ] WebSocket push to dashboard working
- [ ] Dashboard login works cross-origin
- [ ] Service worker updated for new hosting
- [ ] Make.com webhook URL updated
- [ ] Meta Flow endpoint URL updated
- [ ] Old Cloudflare resources decommissioned
