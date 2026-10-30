# Let's talk email templates

SendGrid dynamic templates for replies to Let's talk submitters, and for the internal support forward. Which email a submitter gets depends on the label the AI classification assigns. See [ADR 0001](../adr/0001-lets-talk-ai-classification-and-label-actions.md) and the [plan](../plans/lets-talk-ai-classification.md). Designs: [Figma / Emails](https://www.figma.com/design/ELqqR1RvX3BhFuU3AI8ShI/Emails?node-id=2849-438).

## Which template each label sends

| Label | Template | Processor flow | SSM template id | Suggested subject | Figma |
| --- | --- | --- | --- | --- | --- |
| `COMMUNITY_OPPORTUNITY` (looking for work) | [`lets-talk-developer-getting-started.html`](lets-talk-developer-getting-started.html) | `lets-talk-community-opportunity-reply` | `LETS_TALK_OPPORTUNITY_TEMPLATE_ID` | Getting started on Topcoder as a developer | [2853:1389](https://www.figma.com/design/ELqqR1RvX3BhFuU3AI8ShI/Emails?node-id=2853-1389) |
| `COMMUNITY_SKILLS` (learning, practising) | [`lets-talk-practice-learn-help.html`](lets-talk-practice-learn-help.html) | `lets-talk-community-skills-reply` | `LETS_TALK_SKILLS_TEMPLATE_ID` | Practice, learn and get help on Topcoder | [2853:1485](https://www.figma.com/design/ELqqR1RvX3BhFuU3AI8ShI/Emails?node-id=2853-1485) |
| `COMMUNITY_GENERAL` (no defined direction) | [`lets-talk-community-general-reply.html`](lets-talk-community-general-reply.html) | `lets-talk-community-general-reply` | `LETS_TALK_GENERAL_TEMPLATE_ID` | Welcome to Topcoder | [2849:996](https://www.figma.com/design/ELqqR1RvX3BhFuU3AI8ShI/Emails?node-id=2849-996) |
| `WIPRO_QUERIES` (Wipro employees, Wipro-internal) | [`lets-talk-how-crowdsourcing-works.html`](lets-talk-how-crowdsourcing-works.html) | `lets-talk-wipro-queries-reply` | `LETS_TALK_WIPRO_TEMPLATE_ID` | How crowdsourcing works at Topcoder | [2853:1572](https://www.figma.com/design/ELqqR1RvX3BhFuU3AI8ShI/Emails?node-id=2853-1572) |
| `SALES_LEAD` | [`lets-talk-sales-reply.html`](lets-talk-sales-reply.html) | `lets-talk-sales-reply` | `LETS_TALK_SALES_REPLY_TEMPLATE_ID` | Thank you for your interest in Topcoder | — (no design; uses the shared shell) |
| `COMMUNITY_SUPPORT` (internal, to support) | [`lets-talk-support-forward.html`](lets-talk-support-forward.html) | `lets-talk-support-forward` | `LETS_TALK_SUPPORT_TEMPLATE_ID` | Let's talk support request | — (no design; uses the shared shell) |

The other labels send no reply to the submitter:

- `JUNK`: nothing is sent.
- `COMMUNITY_SUPPORT`: the submission is forwarded internally to `LETS_TALK_SUPPORT_RECIPIENTS` (default `support@topcoder.com`) with the support forward above. Its reply-to is the submitter, so support answers them by replying.
- `UNKNOWN` (classification failed): the existing internal Let's talk email to `LETS_TALK_RECIPIENTS`.

## Dynamic template data

All five reply templates take `firstName` and `viewInBrowserUrl`; the sales reply also uses `interestArea`:

| Variable | Set by the processor | Notes |
| --- | --- | --- |
| `firstName` | Yes, when usable | The submitter's first name: trimmed, whitespace collapsed, at most 40 characters. It is **left out** when it contains a URL, an `@`, digits or markup characters, and the template then greets "there". |
| `viewInBrowserUrl` | No | The "View this email in your browser" line is shown only when this is set. Transactional sends have no hosted web version, so the line stays hidden. |
| `interestArea` | Yes | The display label of the "What are you interested in?" option ("Crowdsourced Innovation", …). It comes from the form's fixed option list, so it's safe to show. Only the sales reply uses it ("I received your inquiry regarding …"); when it's missing the sentence reads "I received your inquiry and …". |

**The processor sends nothing else to any reply template.** No message, company, email address, URL or classification is ever part of the data (ADR 0001, Decision 5). A template that refers to any other variable renders it empty, so **don't add variables without changing the processor first**. This is what keeps the public form from being used to send attacker-written text from Topcoder's domain.

Use the double-brace form `{{firstName}}`, which SendGrid HTML-escapes. Never use triple braces `{{{…}}}`.

### Support forward data

The support forward goes to Topcoder staff, not to the submitter, so it gets the full submission (see the [processor README](../../README.md) and [examples/lets-talk-email.json](../../examples/lets-talk-email.json)):

| Variable | Notes |
| --- | --- |
| `answers.firstname`, `answers.lastname`, `answers.email`, `answers.company`, `answers.briefly_describe_your_inquiry` | As submitted. The inquiry keeps its line breaks (`white-space:pre-wrap`). |
| `answers.interested_in` | The option key (`crowdsourcing`, …). The template maps the three known keys to their display labels with `{{#equals}}`, and shows any other key as it is. |
| `fields` | Every answer as `{key, value}` strings, shown under "All answers". |
| `submissionId`, `submittedAt`, `sourcePage` | Submission metadata. |
| `classification` | `label`, `confidence`, `needsReview`, `rationale`, `workflowRunId`. The section is hidden when it's missing. |

All of these except the metadata and classification are attacker-controllable text, so the same rule applies: double braces only, and keep the subject fixed (don't put submitted values in it).

## Setting up a template in SendGrid

Do this for each template, in each environment (dev and production):

1. In SendGrid, go to **Email API → Dynamic Templates → Create a Dynamic Template**, named after the file (for example `lets-talk-developer-getting-started`).
2. **Add Version → Blank Template → Code Editor.** Paste the HTML file's content as it is. The images already point at the SendGrid CDN (see *Images*).
3. Set the **Subject** from the table above. The `<title>` and preheader are already in the HTML.
4. In **Test Data**, paste the sample below and check the preview, then check it again with `{}` to see the "Hi there" fallback:

   ```json
   { "firstName": "Alex", "interestArea": "Crowdsourced Innovation" }
   ```

   For the support forward, use `payload.data` from [examples/lets-talk-email.json](../../examples/lets-talk-email.json), with a `classification` added:

   ```json
   "classification": { "label": "COMMUNITY_SUPPORT", "status": "CLASSIFIED", "confidence": 0.8, "needsReview": false, "rationale": "Payment not received.", "workflowRunId": "6f1c2a9e-6b7d-4e8f-9a01-2b3c4d5e6f70" }
   ```

5. Send a test email to yourself from the editor and check it in at least Gmail and Outlook, on desktop and mobile.
6. Save, and make the version **active**.
7. Copy the template id (`d-` followed by 32 hexadecimal characters) into the SSM SecureString `/config/forms-processor-v6/appvar/<SSM template id>` from the table, then **redeploy the processor**. Tasks read SSM only at startup.

A flow whose template id is missing doesn't send. Its deliveries wait and retry until the id is set, so templates can go live one at a time. A flow should only be enabled once its template is active (rollout: plan §5).

## Changing a template

1. Edit the HTML file here, and get the change reviewed.
2. In SendGrid, add a **new version** of the same template with the new HTML, test it (steps 4–5 above), and make it active.

The template id doesn't change, so no SSM change or redeploy is needed. Keep the previous version, so you can switch back to it if needed.

**All the templates in this folder share the same header, footer and mobile styles.** Only the content card, `<title>` and preheader differ (the support forward also adds two mobile rules for its label/value tables). A change to the shared shell (logo, footer, social links, styles) must be made in every file and published as a new version of every template.

## Images

The logo and social icons are hosted on the SendGrid CDN. Their URLs are in [assets/icons.txt](assets/icons.txt) and are already used, over `https`, in the HTML. [assets/](assets/) keeps the source PNGs: 2x exports from Figma, displayed at 204×48 (logo) and 32×32 (icons). To replace an image, upload it to the SendGrid Design Library, then update its URL in `icons.txt` and in every HTML file.

## To confirm before going live

The Figma designs don't include these links, so check them first:

- "sign up here" (general reply, developer getting started): `https://accounts-auth0.topcoder.com/?mode=signUp`. The practice email's "create your free account" links to `https://www.topcoder.com/`, as in its design.
- The social links: Facebook, YouTube, LinkedIn, Twitter and Instagram (`https://discord.com/invite/topcoder` comes from the designs).
- The `SALES_LEAD` template has no Figma design; it follows the shared shell. Its signature and `mailto:` are Kiril Kartunov's (hard-coded), while replies go to every `LETS_TALK_SALES_REPLY_TO` address (default `support@topcoder.com`, `test1@topcoder.com`). Set that list for production so it includes the signer.
