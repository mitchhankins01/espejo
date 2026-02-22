# AWS Migration Plan (SST + Usage Alerts + CloudWatch/Error Logging)

## Goal
Migrate `espejo` from Railway-centric deployment to AWS with infrastructure managed in SST, while adding production-grade observability:
- CloudWatch logs and dashboards
- Alerting for app errors and availability
- Usage and cost alerts based on `api_usage` + AWS spend

## Current State (Baseline)
- App runtime: Node/TypeScript service (`src/index.ts`, HTTP + MCP flows + Telegram webhook paths).
- Data: PostgreSQL + pgvector.
- Media: S3-compatible object storage (currently R2 integration exists).
- Usage telemetry: `api_usage` table already tracks provider/model/tokens/cost/latency.
- Deployment: currently documented around Railway.

## Target AWS Architecture
- **IaC**: SST app with `dev`, `staging`, `prod` stages.
- **Compute**:
  - ECS Fargate service for the main API/MCP process (stable runtime for webhook + API traffic).
  - EventBridge-scheduled Lambda(s) for periodic jobs (usage rollups/alerts).
- **Database**: Amazon RDS PostgreSQL 16 with `pgvector` extension enabled.
- **Object Storage**: Amazon S3 (or keep R2 temporarily and migrate later).
- **Secrets**: AWS Secrets Manager + SST `Secret`.
- **Observability**:
  - CloudWatch log groups (structured JSON logs).
  - CloudWatch dashboards (latency, error rate, usage, DB health).
  - CloudWatch alarms + SNS notifications (email/Slack via AWS Chatbot).
- **Network/Security**:
  - VPC with private subnets for DB.
  - ECS tasks in private subnets (NAT as needed for outbound APIs).
  - Least-privilege IAM per service.

## Phase Plan

## Phase 0: Preconditions (1-2 days)
- Lock migration scope (what moves now vs later, including whether S3 migration is in scope now).
- Define SLOs:
  - Availability target for HTTP endpoints
  - Max acceptable error rate
  - Daily/monthly token and cost limits
- Capture current production baseline:
  - request volume/day
  - OpenAI/Anthropic token usage/day
  - OCR volume/day
  - DB size and growth

Exit criteria:
- Written baseline metrics and alert thresholds approved.

## Phase 1: SST Foundation (2-3 days)
- Add SST project files and stage config.
- Define core resources in SST:
  - VPC
  - ECS cluster/service + task definition
  - RDS PostgreSQL instance
  - S3 bucket (if migrating media now)
  - Secrets (API keys, DB URL, Telegram token, webhook secret)
- Add CI/CD path (GitHub Actions -> `sst deploy --stage <env>`).
- Add environment mapping document (`.env` keys -> AWS secrets/params).

Exit criteria:
- `sst deploy --stage dev` provisions runnable dev infrastructure.
- App starts and passes health checks in AWS dev.

## Phase 2: Observability First (1-2 days)
- Switch logger output to structured JSON for CloudWatch parsing.
- Ensure every request/job has correlation fields:
  - `request_id`
  - `chat_id` (when applicable)
  - `provider`, `model`, `operation`
- Configure CloudWatch log groups and retention policy (for example: 30 days dev, 90 days prod).
- Build CloudWatch dashboard:
  - HTTP p95 latency
  - 4xx/5xx counts
  - task restarts
  - DB connections/CPU
  - custom usage metrics (next phase)

Exit criteria:
- Can filter logs by `level=error` and trace one failed request end-to-end.

## Phase 3: Usage + Cost Alerting (2 days)
- Add scheduled usage aggregation job (EventBridge every 5-15 minutes):
  - Query `api_usage` for rolling windows (hour/day/month).
  - Publish CloudWatch custom metrics (namespace: `Espejo/Usage`), e.g.:
    - `CostUsdHourly`
    - `CostUsdDaily`
    - `InputTokensDaily`
    - `OutputTokensDaily`
    - `LatencyMsP95` (by provider/model)
- Add CloudWatch alarms:
  - Daily cost > threshold
  - Monthly projected cost > threshold
  - Error count > threshold in 5-minute windows
  - 5xx rate > threshold
- Add AWS Budgets + Cost Anomaly Detection alarms for account-level guardrails.
- Route all alerts to SNS:
  - email for immediate setup
  - optional Slack channel via AWS Chatbot

Exit criteria:
- Synthetic alert test proves notifications reach on-call channel.
- Dashboard shows custom usage metrics updating on schedule.

## Phase 4: Data Migration + Cutover (2-4 days)
- Provision RDS schema via existing migration script.
- Migrate data from current production DB:
  - initial snapshot (`pg_dump`/restore)
  - optional short delta sync before cutover
- Validate row counts and spot-check critical query paths.
- Deploy app in staging against RDS and run smoke tests:
  - search tools
  - Telegram webhook flows
  - OCR paths
- Cutover sequence:
  - freeze writes (or brief maintenance window)
  - final sync
  - switch endpoints/secrets to AWS
  - monitor alarms and error logs for 60-120 minutes

Exit criteria:
- Production traffic served from AWS with no Sev-1 issues.

## Phase 5: Stabilization + Cleanup (1-2 days)
- Tune alarms to reduce noise (keep actionable alerts only).
- Confirm backup/restore drills for RDS and S3.
- Remove deprecated Railway deployment and stale secrets.
- Update README runbook and operational docs.

Exit criteria:
- AWS is primary and documented; rollback path is retained for one release window.

## Error Logging and Alert Rules (Initial)
- Alarm: `5xx >= 5` in 5 min (prod).
- Alarm: `error logs >= 10` in 10 min with `level=error`.
- Alarm: ECS task restart count > threshold/hour.
- Alarm: DB CPU > 80% for 15 min.
- Alarm: DB free storage below safety threshold.

## Usage Alert Rules (Initial)
- Daily LLM spend > `$X` (set from baseline + margin).
- Monthly LLM spend projection > `$Y`.
- OCR spend/day > expected ceiling.
- Token spike: daily tokens > baseline * 1.5.

## Rollback Plan
- Keep previous deployment path intact for one release window.
- Maintain DB snapshot before cutover.
- If post-cutover error rate breaches threshold for >15 minutes:
  - revert app endpoint/secrets to previous environment
  - replay any queued writes if needed
  - perform incident review before reattempt

## Deliverables Checklist
- [ ] `sst.config.ts` and stage-aware infra definitions
- [ ] AWS secret mapping and bootstrap script/docs
- [ ] CloudWatch dashboard + alarms (error + usage + cost)
- [ ] Scheduled usage-metrics publisher
- [ ] Migration runbook (cutover + rollback)
- [ ] Updated operational README

## Open Decisions
- Region choice (`us-*` vs `eu-*`) and data residency requirements.
- Keep R2 short-term vs immediate S3 migration.
- ECS-only vs mixed ECS/Lambda runtime split for non-HTTP jobs.
- Alert routing target (email only vs Slack + PagerDuty).
