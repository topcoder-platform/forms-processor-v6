# ADR 0001 — AI classification and label-based actions for Let's talk submissions

- **Status:** Accepted, implemented (2026-10-22) on `lets-talk-ai-classification` in forms-processor-v6, forms-api-v6 and platform-ui, and on `PM-6624_letstalk-classificaiton-workflow` in tc-ai-api. See *Implementation notes*. A live end-to-end run in dev is still to do.
- **Date:** 2026-10-21, revised 2026-10-22
- **Plan:** [`docs/plans/lets-talk-ai-classification.md`](../plans/lets-talk-ai-classification.md)
- **Related:** tc-ai-api ADR 0010 (the `lets-talk-classification` workflow, [PM-6624](https://topcoder.atlassian.net/browse/PM-6624)); forms-api-v6 migrations `20260928020000_processor_flows` and `20261013010000_lets_talk_processor_key`; email-service-v6 (the `external.action.email` contract); email templates in [`docs/emails/`](../emails/README.md)

## Context

Every Let's talk submission is emailed to a fixed internal list (`lets-talk-sales-email`, which matches every `lets_talk` submission). Someone then triages it by hand. Real traffic is mostly not sales: in the June–September 2026 HubSpot export, about 74% of submissions were prospective community members, 13% junk and 12% sales leads, and 45% had an empty message.

tc-ai-api now offers an M2M-only workflow, `lets-talk-classification`. It returns a label, a confidence per class, `needsReview`, a rationale, and a persisted run. Since its ADR 0010 revision 2 (2026-10-22) there are seven classes:

- `JUNK`;
- `COMMUNITY_OPPORTUNITY` (looking for work);
- `COMMUNITY_SKILLS` (learning or improving skills);
- `COMMUNITY_SUPPORT` (a problem to fix);
- `COMMUNITY_GENERAL` (no defined direction);
- `WIPRO_QUERIES` (Wipro employees and Wipro-internal matters);
- `SALES_LEAD`.

The earlier four-class set reached 96.6% accuracy on 206 labeled samples. The seven-class set hasn't been re-measured yet.

The requirements:

1. Classify each submission with that workflow, wait for the result, and process it.
2. Store the label with the submission (`UNKNOWN` by default), together with the AI run id, and show it in the reports UI (`reports.topcoder.com/forms`).
3. Act on the label:
   - JUNK: nothing;
   - COMMUNITY_OPPORTUNITY, COMMUNITY_SKILLS, COMMUNITY_GENERAL and WIPRO_QUERIES: a reply to the submitter, each with its own template (see [`docs/emails/`](../emails/README.md)). For WIPRO_QUERIES this was confirmed on 2026-10-22: an automatic reply, not an internal hand-off;
   - COMMUNITY_SUPPORT: forward to `support@topcoder.com`;
   - SALES_LEAD: a templated reply whose reply-to comes from a configurable list (`LETS_TALK_SALES_REPLY_TO`, default `support@topcoder.com`, `test1@topcoder.com`; Decision 7).
4. Replace the "send everything to fixed emails" behaviour.

Constraints from the existing system:

- forms-processor-v6 routes a submission to **all** matching flows at once, using rules on answers only. It holds a row lock for the length of each action, and the pool's idle-in-transaction limit is 45 s.
- The processor's email action deliberately takes recipients **only from trusted configuration**.
- email-service-v6 accepts **one** `replyTo`.
- The AI workflow's access policy is scopes-only, so administrator member tokens can't read its runs.
- The Let's talk form allows 500-character names and company. The workflow's input schema caps them at 100/100/200 and expects the selector's display labels, while the form sends stable keys.

## Decision

### 1. The processor calls the AI workflow as a flow action

A new `ai-classify` action runs as the `lets-talk-classify` flow. It calls `POST /v6/ai/workflows/lets-talk-classification/start-async?runId=<uuid>` with an M2M token and waits for the result.

- **Deadline.** The call is limited to 30 s, below the 45 s transaction limit.
- **Timeouts.** The run id is stored with the deferred retry. The next attempt reads the run (`GET …/runs/:runId`) instead of starting another, so a slow call isn't paid for twice. The id of a failed run is never reused: Mastra overwrites a reused run id.
- **Input mapping.** It lives in code and is unit-tested:
  - selector keys are converted to their display labels;
  - `submittedAt` is normalized to UTC `Z`;
  - the optional message is omitted when empty;
  - UTM and campaign fields are never sent.
- **Retries:**
  - **Invalid input** is final straight away.
  - **Invalid model output** and provider errors retry with a new run, up to 5 attempts.
  - **HTTP and network failures** retry with the existing backoff, but only for 30 minutes from receipt.

  - **A run that never finishes** (still `running` after the age limit, e.g. left behind by a tc-ai-api crash) is given up as well (`ai_run_stuck`).

  After that the submission is marked **FAILED** (label `UNKNOWN`), and Decision 6 applies. The limits are `LETS_TALK_CLASSIFY_MAX_ATTEMPTS` (5) and `LETS_TALK_CLASSIFY_MAX_AGE_MINUTES` (30).

### 2. Two-stage routing through a `classification` rule key

Flow `rules` gain an optional `classification` list, for example `{"all": [], "classification": ["SALES_LEAD"]}`.

- **Stage 1.** Routing on arrival ignores flows that have the key.
- **Stage 2.** When `ai-classify` succeeds, one transaction:
  1. writes the classification;
  2. inserts deliveries for the form's flows whose `classification` list contains the label (and whose answer rules match);
  3. marks the classify delivery delivered.
- **No partial state.** A label never exists without its actions, nor actions without a label.
- **Only enabled flows.** Unlike stage 1, stage 2 creates no delivery for a disabled flow. Stage-1 deliveries queue until a flow is enabled, but label actions are replies, and a reply queued while its flow was off (for example during shadow mode, Decision 8) must not go out weeks later when the flow is enabled.
- **JUNK** has no flow, so it creates no delivery.
- **Backward compatible.** Rules without the key behave exactly as before. A separate key, not an answer predicate, can't collide with a form field.

Flows (seeded disabled by a forms-api-v6 migration):

| Flow | Action | `classification` |
| --- | --- | --- |
| `lets-talk-classify` | `ai-classify` | *(stage 1)* |
| `lets-talk-community-opportunity-reply` | `sendgrid-email`, to the submitter | `COMMUNITY_OPPORTUNITY` |
| `lets-talk-community-skills-reply` | `sendgrid-email`, to the submitter | `COMMUNITY_SKILLS` |
| `lets-talk-community-general-reply` | `sendgrid-email`, to the submitter | `COMMUNITY_GENERAL` |
| `lets-talk-wipro-queries-reply` | `sendgrid-email`, to the submitter | `WIPRO_QUERIES` |
| `lets-talk-support-forward` | `sendgrid-email`, to `support@topcoder.com`, reply-to the submitter | `COMMUNITY_SUPPORT` |
| `lets-talk-sales-reply` | `sendgrid-email`, to the submitter, reply-to and copies from `LETS_TALK_SALES_REPLY_TO` | `SALES_LEAD` |
| `lets-talk-sales-email` (existing) | `sendgrid-email`, to `LETS_TALK_RECIPIENTS` | `UNKNOWN` (fallback, Decision 6) |

As for the existing flow, SSM values are authoritative for every Let's talk flow: template ids, the support recipients, the reply-to pool, and the AI API URL and audience. Changing them needs a redeploy.

### 3. Classification is stored in a new table, `forms."SubmissionClassification"`

The table is added by a forms-api-v6 migration, which owns the schema. It has one row per submission, holding:

- `label` (default `UNKNOWN`) and `status` (`PENDING` | `CLASSIFIED` | `FAILED`);
- `confidence`, `needsReview`, `detectedLanguage`, `rationale`;
- `workflowId` and `workflowRunId`;
- `attempts`, `lastError`, and timestamps.

It references `Submission` with `ON DELETE CASCADE`. A submission without a row is reported as `UNKNOWN`, which covers everything submitted before this change.

`label` is a `VARCHAR`, not an enum. The class set is configurable in tc-ai-api, and a new class must not need a database migration. A label that no flow lists simply triggers no action.

### 4. Reporting surfaces the label; the UI renders it

The forms-api-v6 report and CSV export gain these columns for forms that have an `ai-classify` flow: `classification`, `classification_status`, `classification_confidence`, `classification_needs_review`, `classification_run_id`. The platform-ui reports page renders `classification` as a coloured badge, marks `needsReview`, and shows the run id.

The UI does **not** depend on reading the AI run. Confidence and rationale are copied into our table, because tc-ai-api's policy denies member tokens on that workflow.

### 5. Submitter-facing emails get minimal, sanitized data built in code

Sending to an address typed into a public form makes the processor a possible spam relay: anyone can enter a victim's address. This ADR therefore deliberately changes the rule "recipients never come from the submission", under these conditions:

- **Only labelled submissions get replies.** Only `COMMUNITY_OPPORTUNITY`, `COMMUNITY_SKILLS`, `COMMUNITY_GENERAL`, `WIPRO_QUERIES` and `SALES_LEAD` reply to the submitter. JUNK and UNKNOWN never do, and `COMMUNITY_SUPPORT` is forwarded internally instead.
- **Minimal template data.** For flows that send to the submitter, the processor **builds the template data itself** and doesn't pass the event:
  - `firstName`: trimmed, whitespace collapsed, at most 40 characters. It is dropped when it contains a URL, an `@`, digits or markup characters, and the template then falls back to a generic greeting.
  - `interestArea`: the **display label** of the `interested_in` option. It comes from the form's allowlist, so it's safe.

  No message, company or other free text can reach a reply, whatever a template contains. Internal flows (the support forward, the `UNKNOWN` fallback) keep the full submission plus a `classification` object.
- **Rate limit.** At most one reply per recipient address per 24 hours (`LETS_TALK_REPLY_CAP_PER_DAY`), checked against delivery history.
- **One variable convention for every template.** Template variables are camelCase. All five reply templates in [`docs/emails/`](../emails/README.md) use `{{firstName}}`; [`lets-talk-sales-reply.html`](../emails/lets-talk-sales-reply.html) also uses `{{interestArea}}`. Both are optional and have fallbacks.

### 6. Failure falls back to today's behaviour

A submission whose classification ends `FAILED` keeps the label `UNKNOWN`. It is routed to the existing `lets-talk-sales-email` flow, reconfigured to `classification: ["UNKNOWN"]`. An AI outage or a bad model answer therefore degrades to the current internal email instead of losing a lead.

`needsReview` doesn't change the action; it is shown in the UI. Holding auto-replies for review would affect at least the 45% of submissions with an empty message (Q1).

### 7. Sales reply: the first listed address gets the replies, the rest are copied

Decided 2026-10-22, revising the earlier "one address per submission from a pool". The sales reply should reach a configurable list of people (`LETS_TALK_SALES_REPLY_TO`). email-service-v6 accepts a single `replyTo`, so:

- the **first** address in the list is the `replyTo` (default `support@topcoder.com`);
- **every other** address is **copied (`cc`)** on the reply sent to the prospect (default `test1@topcoder.com`).

The copies also mean the sales team sees every sales reply, which answers Q4.

The template keeps Kiril Kartunov's signature and `mailto:` (Q8). With the defaults (2026-10-23: `support@topcoder.com`, `test1@topcoder.com`), a prospect who presses Reply writes to support, not to the signer. For production, set `LETS_TALK_SALES_REPLY_TO` so its first address is the person who signs. A list with all addresses as true reply-to targets would need SendGrid's `reply_to_list` in email-service-v6, which stays a possible follow-up.

### 8. Shadow-mode rollout

1. **Shadow mode.** Enable `lets-talk-classify` first, with `lets-talk-sales-email` temporarily back on `{"all": []}`: labels are recorded and visible, and the legacy email still goes out for everything.
2. **Review.** After 1–2 weeks of label review by sales and support, switch everything in one reviewed SQL change ([`examples/lets-talk-cutover.sql`](../../examples/lets-talk-cutover.sql)): the fallback goes back to `UNKNOWN` and the six label flows are enabled. Submissions classified during shadow mode are not re-actioned, because stage 2 only routes enabled flows (Decision 2).
3. **Rollback** is the reverse SQL change.

### 9. tc-ai-api input limits are raised to the form's

`firstName`, `lastName` and `companyName` go to 500 characters, and `memberId` to 200. A valid long submission must not fail classification as invalid input. The model view already truncates text, so the prompt size doesn't change.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| tc-ai-api consumes `form.submitted` itself and publishes a result event | It moves form-specific logic and personal data handling into the AI service, and adds a topic and a second consumer. The processor already has the inbox, retries and receipts; one HTTP call per submission is enough at this volume (a few per day). |
| Run the classification at submit time in forms-api-v6 | The website would wait several seconds for the AI. AI failures would become submission failures. |
| A separate topic per label for follow-up actions | More infrastructure for the same result. A rule key plus same-transaction stage-2 routing stays inside the existing table model. |
| Label columns on `Submission`, or answers in the form schema | `Submission` is an immutable envelope, and form versions are immutable definitions. Classification is mutable processing state with its own lifecycle. |
| A database enum for the label | It couples the schema to the class set configured in tc-ai-api. |
| Pass the full event to every template (today's behaviour) | Safety would depend on every template author never rendering free text. Building the data in code makes it a guarantee. |
| Hold the row lock until the AI answers, however long it takes | Model-call latency has no fixed bound (up to 18 calls in the worst case), so it could exceed the 45 s limit. A 30 s deadline with polling by run id keeps the existing lock model. |

## Consequences

- **Lighter manual triage.** JUNK, community and support submissions no longer reach the sales inbox once the fallback flow is limited to `UNKNOWN`.
- **Submitters now get emails.** Those emails are at-least-once, as all processor actions are: a crash after Bus API accepts one can send a duplicate. The per-address cap limits the impact.
- **Personal data now also sits in** `SubmissionClassification` (the rationale can paraphrase the message) and in tc-ai-api run records. The table is erased with the submission; AI run retention is the open follow-up recorded in tc-ai-api ADR 0010.
- **Changing the class set in tc-ai-api needs a flow review here.** A new label triggers nothing until a flow lists it.
- **The processor's database login needs** `SELECT/INSERT/UPDATE` on the new table, and the processor test fixtures get a copy of the migration (existing convention).
- **New SSM parameters:**
  - `AI_API_URL` and optionally `AI_AUTH0_AUDIENCE`;
  - reply template ids `LETS_TALK_OPPORTUNITY_TEMPLATE_ID`, `LETS_TALK_SKILLS_TEMPLATE_ID`, `LETS_TALK_GENERAL_TEMPLATE_ID`, `LETS_TALK_WIPRO_TEMPLATE_ID`, `LETS_TALK_SALES_REPLY_TEMPLATE_ID`, and `LETS_TALK_SUPPORT_TEMPLATE_ID`;
  - `LETS_TALK_SUPPORT_RECIPIENTS` and `LETS_TALK_SALES_REPLY_TO`;
  - `LETS_TALK_CLASSIFY_MAX_ATTEMPTS`, `LETS_TALK_CLASSIFY_MAX_AGE_MINUTES`, `LETS_TALK_REPLY_CAP_PER_DAY`.

  All are optional processor SecureStrings read by `deploy/release.py`. An absent template id or recipient list leaves its flow's deliveries waiting (`invalid_email_settings`), so templates can go live one at a time.

## Resolved questions

1. **Q1 `needsReview`:** act on the label anyway, and show the flag in the UI (Decision 6).
2. **Q2 Failure:** fall back to the legacy internal email (Decision 6).
3. **Q3 / Q8 Reply-to and signature** (answered 2026-10-22): the template keeps Kiril's signature; replies go to the first `LETS_TALK_SALES_REPLY_TO` address and the rest are copied (Decision 7).
4. **Q4 Internal sales notification:** covered by the copies in Decision 7.
5. **Q5 Support:** an email to `support@topcoder.com` (`LETS_TALK_SUPPORT_RECIPIENTS`), with reply-to set to the submitter.
6. **Q6 Backfill:** none; historical submissions report as `UNKNOWN`.
7. **The response shapes of `start-async` and `GET …/runs/:runId`** were read from the installed Mastra 1.74 server. Both return `{ status, result?, error? }`; the run read accepts `?fields=result,error` and returns 404 for an unknown run.

## Open

- **Q7 Run link:** the UI shows the run id with a copy button, but no link yet. Where it should point (Mastra Studio, or admin read access to the workflow's runs in tc-ai-api) is still to decide.
- **M2M client:** confirm in dev that the processor's M2M client holds `ai:letstalk:classify` and that tc-ai-api accepts its token audience (`AI_AUTH0_AUDIENCE` overrides the Bus API audience if needed).
- **Live run:** one end-to-end test per label in dev (plan §6).

## Implementation notes (2026-10-22)

| Repository | Change |
| --- | --- |
| forms-api-v6 | Migration `20261022010000_lets_talk_classification`: the `SubmissionClassification` table (with CHECK constraints for label format, status, confidence range and complete `CLASSIFIED` rows) and the seven disabled flows. `lets-talk-sales-email` is unchanged by the migration. The report and CSV gain the classification columns, and a `classification` filter (`UNKNOWN` also matches submissions with no row). |
| forms-processor-v6 | `ai-classify` action (`src/classify.ts`), AI client (`src/ai.ts`), shared M2M token provider (`src/auth.ts`), Let's talk input mapping and reply data (`src/lets-talk.ts`), flow settings from SSM (`src/lets-talk-flows.ts`). Two-stage routing and classification writes in `src/store.ts`. The email action gains `recipientsFromAnswer`, `replyTo`, `replyToFromAnswer`, `cc` and `replyCapPerDay`; existing settings keep working. `deploy/release.py` passes the new SSM parameters. |
| platform-ui | Reports → Forms: classification badge (first in each Let's talk card, also in tables), "Needs review" marker, confidence as a percentage, run id with copy button, and a Classification filter that also applies to the filtered CSV. |
| tc-ai-api | Input limits raised to the form's (Decision 9). |

Decided while implementing:

- **Stage 2 routes only enabled flows** (Decision 2). Found while testing shadow mode: routing disabled flows, as stage 1 does, would have queued every shadow-mode reply for sending at cut-over.
- **A deleted submission** (retention or erasure before classification) completes the classify delivery as `skipped_submission_missing`, with no row and no actions, instead of retrying forever on the foreign key.
- **Skipped deliveries** (`reply_cap`, `no_recipient_address`, `submission_missing`) are marked delivered with `lastError = skipped_<code>`, so they stop retrying and stay visible. They don't count toward the reply cap.
- **The classify retry state** (run id, attempts, last error) is saved in `SubmissionClassification` with each deferred retry, in the same transaction.

Verified locally, against PostgreSQL 17 in a throwaway container:

- **forms-api-v6:** lint, typecheck and build pass; 69 unit tests; 26 integration tests, 2 of them new: the classification report, filter and CSV, and the seeded flows.
- **forms-processor-v6:** lint, typecheck and build pass; 57 unit tests and 15 integration tests, 7 of the integration tests new. They cover two-stage routing, JUNK, disabled stage-2 flows, retry state, the `UNKNOWN` fallback, a deleted submission, the reply-cap counter and the seeded flows. The 10 release-script tests pass in Python 3.13.
- **platform-ui:** reports app 79 tests; eslint and `tsc` clean.
- **tc-ai-api:** Let's talk and config tests (165).
