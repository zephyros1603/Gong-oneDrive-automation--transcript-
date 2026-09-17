# Product notes

**Status: a record of one strategy conversation, 17 September 2026. Nothing
here is decided.** It is kept because the reasoning is easy to lose and
expensive to reconstruct.

Three kinds of claim appear below and they are not equally solid:

- **Measured** — taken from this repo's own usage table. Trustworthy.
- **Assessment** — opinion, argued. Disagree freely.
- **Open** — genuinely undecided, needs evidence from outside this room.

---

## 1. The problem, stated properly

*Assessment.*

"Generates documents" undersells it. The actual job:

> A call produces commitments, and five systems need to know about them —
> minutes, a recap email, a status report, an action tracker, a Jira ticket.
> All five are derived from one transcript. Today a human re-types that
> derivation by hand, five times, inconsistently, days late.

An implementation consultant doing five calls a day loses two to three hours to
that. For a delivery org that is a **utilization** number, which is legible to a
CFO in a way "we save time on notes" is not.

The wedge is therefore not *"AI writes your docs"* but *"your consultants bill
six hours and spend two on admin."*

## 2. The reframe: be the write path, not the tool

*Assessment.*

The original framing was "PM tools are out of date, AI fixes them." Half right.
Jira is not bad software. The problem is that **PM tools require manual entry of
information that already exists in unstructured form somewhere else.** The tool
is fine; the input pipeline is a human.

So: do not build a better PM tool. That is a graveyard, and it means fighting
incumbents for their own users. Build **the write path into the tools people
already have.** Smaller surface, far less competition, and you inherit their
distribution instead of attacking it.

## 3. The durable object is a commitment ledger

*Assessment. This is the part worth arguing about.*

The thing worth owning is not a document. It is a ledger of every decision,
owner, date, dependency and risk, extracted per call, tracked **across** calls,
each item citing the transcript timestamp where it was said.

Documents and tickets become *views* of that ledger. Two consequences:

1. It gives you something no existing tool holds.
2. It lets you be right about something over time:

   > *"This action item has slipped across four calls in three weeks. Nobody has
   > raised it."*

That is escalation detection, and it is worth more than any document the system
generates. Gong can already summarise a call. **Nobody is tracking whether what
was promised on the call actually happened.** That gap is the product.

## 4. Where I'd push back hardest

*Assessment, stated as disagreement with the original framing.*

> "there is only less need for human intervention"

This is the part that kills products in this category.

At 100 calls/day, a 90%-accurate system produces **ten wrong updates per day
flowing into the system of record.** Bad data in a PM tool is worse than no
data: people stop trusting the board, then stop looking at it, then you are
uninstalled. Separately, nobody will let an unreviewed AI email reach a client.

The goal is not *less* human involvement. It is **cheaper** human involvement —
turn a 40-minute authoring task into a 90-second approval:

- Review as a **diff**, not as proofreading.
- Every extracted item carries a **confidence score** and a **jump-to-timestamp
  citation**, so verifying is a glance rather than a re-read.

Aim for zero humans and you lose trust on the first bad ticket and never
get it back. Citations are the single highest-leverage thing to build next, and
they are cheap.

## 5. Unit economics

*Measured — from this repo's `usage` table, 31 runs.*

Completed runs only (cancelled runs are recorded with no reported cost, and
including them understates the real figure):

| Action | n | mean | min | max | turns |
|---|---|---|---|---|---|
| WSR | 11 | **$1.41** | $0.74 | $2.44 | 5–28 |
| MOM + email | 4 | **$1.06** | $0.68 | $1.47 | 11–18 |
| Ad-hoc question | 6 | **$0.56** | $0.10 | $1.23 | 1–15 |

Mean completed run: **$1.10**. Ten of 31 runs were cancelled or recorded zero
cost — a 32% abandon rate that is itself worth understanding.

**At 100 calls/day, one MOM each: ~$106/day ≈ $2,300/month per org**, before
weekly and monthly reports. That sets a price floor.

*Assessment:* this is a **tooling** cost, not an inference floor. You are paying
for an agentic CLI that reads files, shells out to Python and writes `.docx` —
5 to 28 turns per run. An API-native pipeline doing structured extraction
against a transcript already in memory should land nearer **$0.05–0.15 per
call**. Roughly a 10× reduction is available, and you will need it at B2B
volume. The WSR turn range (5–28) is the tell: the variance is agent wandering,
not task difficulty.

## 6. What must change before this is sellable

*Assessment, but the facts underneath are certain.*

Three things are fine for one person and disqualifying for a customer:

1. **Gong access.** A browser session cookie against undocumented internal
   endpoints. Per-user, expires in ~16 days, and not something you can ask
   another company to do. B2B means the official Gong API with OAuth — a real
   migration that changes the data model, so do it early rather than late.
2. **The engine.** `claude -p` under a personal subscription cannot serve other
   tenants. The `Engine` interface already exists; the Anthropic adapter is the
   work, and it needs a tool loop, sandboxing and skill loading that the CLI
   currently provides for free.
3. **Tenancy, retention, SOC 2.** Call transcripts are among the most sensitive
   data a company holds — pricing, complaints, personnel. Procurement asks on
   the first call. A real cost line, not a checkbox.

## 7. Competitive position — honestly

*Assessment.*

Gong ships AI summaries. Fireflies, Otter, Grain and Fathom all do
call → notes → CRM. Atlassian ships Intelligence. **The transcript → summary
step is already commoditised**, and assuming otherwise is the most likely way to
waste a year.

Defensibility is downstream and boring:

- correct **house-style** artifacts (the skills folder is more defensible IP
  than any model work)
- written into the **right project with the right fields**
- **tracked across calls**

Nobody does cross-tool well because it is unglamorous integration work. That is
the opportunity, and it is also why a big incumbent probably will not take it —
each of them will do it for their own surface only.

## 8. Buyer and positioning

*Assessment.*

The buyer is a **VP of Services or delivery lead** at a professional-services or
implementation org — someone measured on utilization and on-time delivery. Not
IT, not whoever administers the PM tool.

Best-fit segments: systems integrators and consultancies, B2B SaaS
implementation and customer-success teams, agencies doing client status
reporting.

Aquera is a good beachhead precisely because integration projects produce
**highly repeatable** artifacts. That is also the trap — see §10.

## 9. Next three moves, if it were mine

*Assessment.*

1. **Citations and confidence on every extracted item.** Nothing else matters
   until verification is cheap.
2. **One PM tool done completely** — Jira, since it is already in use.
   Bidirectional, field-level, idempotent. Five shallow integrations are worth
   less than one that never needs correcting.
3. **A metric, from day one:** *percentage of auto-captured action items that
   survive review unedited.* Above ~85% is a product; below ~60% is a demo.

Later: calls are perhaps 40% of where commitments are made. Email and Slack
carry the rest. The commitment ledger is what lets those sources be added
without a redesign.

## 10. Risks

- **Solving only your own workflow.** The unfair advantage is doing this job
  daily — the hardest thing to fake. The matching trap is that the house-style
  assumptions baked into the skills will break on the second org. *Find a second
  design partner earlier than feels comfortable.*
- **Trust is lost once.** See §4.
- **The demo-to-production gap.** 90% is a great demo and a bad system of record.
- **Incumbent encroachment.** Mitigated by cross-tool scope, not by speed.

## 11. Open questions

*Open — none of these can be answered from inside this repo.*

- Would a delivery lead pay for this, or is admin time absorbed as "the job"?
- Is the commitment ledger the product, or is document generation the thing
  people actually buy and the ledger merely interesting?
- What is the real accuracy on unedited action-item capture? Unmeasured today,
  and it decides everything in §4.
- Per-seat, per-call, or platform fee? The $2,300/month inference floor at
  100 calls/day shapes this more than positioning does.
- Does the 32% run-abandon rate reflect cost anxiety, slow runs, or wrong
  output? Each implies a different fix.

---

## Correction

An earlier version of this analysis quoted MOM at **$0.60–0.80**. The measured
figure across completed runs is **$1.06 mean, $0.68–1.47**. That roughly doubles
the projected inference cost at volume, which is material to §5 and §11.
