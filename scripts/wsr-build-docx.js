// scripts/wsr-build-docx.js — the real thing: builds the actual navy
// title-block .docx for every active customer's Weekly Status Report, by
// pulling Gong + CX Portal data.
//
// Run scripts/wsr-weekly-prep.js first (or at least earlier the same week) —
// this script does NOT pull Gong itself; it reads whatever transcripts are
// already on disk, same as core/workflow/projectContext.js's update run.
//
// Two genuinely different steps per customer, mirroring
// skills/weekly-status-report's own two-part design:
//
//   1. EXTRACTION (needs judgment, not code) — warp.claude.run() reads this
//      week's Gong transcripts plus fresh CX Portal data and returns the
//      report's *content* as JSON matching references/input_schema.md from
//      the skill (customer, week_of, discussed[], projects[] with
//      action_items[] and go_live). This is the one Claude call per
//      customer, and it's a real cost — see skills/weekly-status-report's
//      own numbers (that skill alone runs $0.84-2.44 per report).
//
//   2. LAYOUT (mechanical, no judgment) — the exact same table/paragraph
//      construction as skills/weekly-status-report/scripts/build_wsr.js,
//      ported line-for-line onto warp.docx (added to core/engine/api.js
//      alongside this script — the `docx` npm package's own classes,
//      unwrapped, the same pattern as warp.excel.Workbook). No Claude call;
//      this is why the layout comes out byte-identical every time no matter
//      who or what generated the JSON.
//
// warp.claude.run() is silent:true and cannot itself write a file that
// reaches Approvals (see scripts/wsr-weekly-prep.js's header for why) — it
// is used here ONLY to get text back, never to produce the document. The
// document is built entirely by this script's own code and saved with
// warp.docx.save(), then proposed for review like any other script output.

// ============================================================
// CONFIGURATION
// ============================================================

// Monday-to-now — matches the skill's own "Week Of" convention.
const WINDOW = { preset: 'week', anchor: 'this' };

// Skip a customer entirely if they had no Gong call in the window — nothing
// to report on, and skills/weekly-status-report says as much (a WSR is
// built FROM that week's calls).
const REQUIRE_CALLS_THIS_WEEK = true;

// Milliseconds between customers — each one is a real Claude call.
const PACE_MS = 2000;

// ============================================================
// STEP 1 HELPERS — gather active customers + their week's material
// ============================================================

// Same hideClosed:true "active" definition as scripts/workbook-all-projects.js.
async function fetchActiveProjectsByCustomer() {

  const rows = [];
  let cursor = null;
  let total = Infinity;

  for (let page = 0; page < 20 && rows.length < total; page++) {

    const result = await warp.cxp.myProjects({ size: 200, cursor, hideClosed: true });

    rows.push(...(result.projects || []));
    total = result.total ?? rows.length;
    cursor = result.nextCursor || null;

    if (!cursor) break;
  }

  const byCustomer = new Map();

  for (const row of rows) {

    const cxpProjectId = row.projectId || row.displayId;
    if (!cxpProjectId) continue;

    const customerName = row.customerName || row.name || "Unknown Customer";

    if (!byCustomer.has(customerName)) byCustomer.set(customerName, []);

    byCustomer.get(customerName).push({
      cxpProjectId,
      displayId: row.displayId || null,
      name: row.name || row.displayId || cxpProjectId
    });
  }

  return byCustomer;
}

function weekOfLabel(w) {
    // w.fromDay / w.toDay are already resolved calendar days (see
    // warp.window.resolve()); format as "September 21-25, 2026" per the
    // skill's own Header convention.
    const from = new Date(w.from);
    const to = new Date(w.to - 1);
    const sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();
    const fmt = (d, opts) => d.toLocaleDateString("en-US", opts);
    if (sameMonth) {
        return `${fmt(from, { month: "long" })} ${from.getDate()}-${to.getDate()}, ${to.getFullYear()}`;
    }
    return `${fmt(from, { month: "long", day: "numeric" })} - ${fmt(to, { month: "long", day: "numeric" })}, ${to.getFullYear()}`;
}

// A JSON code fence, a leading heading, or trailing commentary around the
// JSON despite being told not to — same defensive unwrap
// core/workflow/projectContext.js's stripWrapper() does for context.md.
function extractJson(text) {
    let t = String(text || "").trim();
    const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(t);
    if (fenced) t = fenced[1].trim();
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
        throw new Error("no JSON object found in the model's reply");
    }
    return JSON.parse(t.slice(start, end + 1));
}

// ============================================================
// STEP 1 — extract this WSR's content as JSON, per customer
// ============================================================

const EXTRACTION_INSTRUCTION = `You are preparing the JSON input for this team's Weekly Status Report
builder. Read the attached Gong call transcript(s) and CX Portal project
data for this customer's active project(s) this week, and output ONLY a
single JSON object — no markdown fence, no commentary before or after —
matching exactly this shape:

{
  "customer": "string",
  "week_of": "string, e.g. \\"September 21-25, 2026\\"",
  "report_date": "string, e.g. \\"September 25, 2026\\"",
  "discussed": ["4-6 bullets, past tense, one decision/outcome per bullet"],
  "projects": [
    {
      "name": "string, e.g. \\"Dayforce -> AD/Entra\\"",
      "calls_held": "string, e.g. \\"1 (Tue, Sep 22)\\" - count plus weekday and date of each call this week",
      "action_items": [
        { "topic": "string", "action": "string ending in a period", "owner": "string", "blocker": "string, or \\"None\\"" }
      ],
      "go_live": {
        "target": "string date, or \\"TBD\\"",
        "changed": true or false,
        "summary": "1-2 sentences",
        "next_week": "one sentence"
      }
    }
  ]
}

Rules, from this team's house style:
- Only include action items still open at the end of the week; things
  finished during a call belong in a "discussed" bullet instead, not here.
- Never invent dates, owners, or decisions. If the transcripts don't say,
  use "TBD" for a go-live target and leave the bullet out rather than guess.
- Don't attribute blame in a blocker — phrase it as "Pending from <party>",
  never "the customer did X wrong".
- A project with no open action items still needs an entry with an empty
  action_items array.

Output nothing but the JSON object.`;

async function extractWsrData(customerName, weekOfText, reportDateText, files) {

    const reply = await warp.claude.run({
        instruction: `${EXTRACTION_INSTRUCTION}\n\nCustomer: ${customerName}\nWeek Of: ${weekOfText}\nReport Date: ${reportDateText}`,
        files,
        label: `WSR extraction — ${customerName}`
    });

    const data = extractJson(reply);

    // Fill in what we already know authoritatively rather than trust the
    // model to echo it back correctly.
    data.customer = customerName;
    data.week_of = data.week_of || weekOfText;
    data.report_date = data.report_date || reportDateText;

    return data;
}

// ============================================================
// STEP 2 — the exact layout from
// skills/weekly-status-report/scripts/build_wsr.js, ported onto warp.docx.
// Mechanical only: no judgment calls happen below this line.
// ============================================================

function buildWsrDocument(data) {

    const {
        Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        WidthType, ShadingType, BorderStyle, AlignmentType, VerticalAlign,
        VerticalMergeType, TableLayoutType, PageOrientation, LevelFormat
    } = warp.docx;

    const FONT = "Calibri";
    const NAVY = "1F3864";
    const RED = "B02A2A";
    const GREEN = "1B7F3A";
    const BODY_TXT = "000000";
    const ACTION_TXT = "242424";
    const GRID = "B7B7B7";
    const HDR_SZ = 16;
    const CELL_SZ = 15;
    const cellBorder = { style: BorderStyle.SINGLE, size: 2, color: GRID };
    const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
    const tblBorder = { style: BorderStyle.SINGLE, size: 4, color: "auto" };
    const tblBorders = {
        top: tblBorder, bottom: tblBorder, left: tblBorder, right: tblBorder,
        insideHorizontal: tblBorder, insideVertical: tblBorder
    };
    const cellMargins = { top: 60, bottom: 60, left: 90, right: 90 };

    const run = (text, o = {}) => new TextRun({ text: String(text ?? ""), font: FONT, ...o });

    function cell(width, text, o = {}) {
        const { bold = false, color = BODY_TXT, center = false, header = false, vMerge, empty = false } = o;
        const p = empty
            ? new Paragraph({ children: [] })
            : new Paragraph({
                alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
                children: [run(text, {
                    bold: header || bold,
                    color: header ? "FFFFFF" : color,
                    size: header ? HDR_SZ : CELL_SZ
                })]
            });
        return new TableCell({
            width: { size: width, type: WidthType.DXA },
            borders: cellBorders,
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: header ? { type: ShadingType.CLEAR, color: "auto", fill: NAVY } : undefined,
            verticalMerge: vMerge,
            children: [p]
        });
    }

    function table(widths, headers, bodyRows) {
        const total = widths.reduce((a, b) => a + b, 0);
        return new Table({
            width: { size: total, type: WidthType.DXA },
            columnWidths: widths,
            layout: TableLayoutType.FIXED,
            borders: tblBorders,
            rows: [
                new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(widths[i], h, { header: true })) }),
                ...bodyRows
            ]
        });
    }

    const sectionHeading = (text) => new Paragraph({
        spacing: { before: 200, after: 80 },
        children: [run(text, { bold: true, color: NAVY })]
    });

    const isNone = (s) => !s || /^\s*(none|n\/a|-|—)\s*$/i.test(s);

    const projects = data.projects || [];
    const projectCount = data.projects_count ?? projects.length;
    const meta = (label, value, boldValue = false) => [
        run(label, { bold: true, size: 16 }),
        run(value, { bold: boldValue, size: 16 })
    ];

    const children = [
        new Paragraph({
            alignment: AlignmentType.CENTER, spacing: { after: 20 },
            children: [run("Weekly Status Report", { bold: true, color: NAVY, size: 30 })]
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER, spacing: { after: 100 },
            children: [run(data.customer, { bold: true })]
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER, spacing: { after: 60 },
            children: [
                ...meta("Week Of: ", data.week_of),
                run("    |    ", { size: 16 }),
                ...meta("Report Date: ", data.report_date),
                run("    |    ", { size: 16 }),
                ...meta("Projects: ", String(projectCount), true)
            ]
        })
    ];

    children.push(sectionHeading("What Was Discussed"));
    for (const b of data.discussed || []) {
        children.push(new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [run(b)] }));
    }

    children.push(sectionHeading("Action Item"));
    children.push(new Paragraph({ children: [] }));
    const AW = [1900, 2500, 5100, 1600, 2400, 1340];
    const actionRows = [];
    for (const p of projects) {
        const items = (p.action_items && p.action_items.length)
            ? p.action_items
            : [{ topic: "—", action: "No open action items this week.", owner: "—", blocker: "None" }];
        items.forEach((it, i) => {
            const first = i === 0;
            const merge = items.length > 1 ? (first ? VerticalMergeType.RESTART : VerticalMergeType.CONTINUE) : undefined;
            actionRows.push(new TableRow({
                children: [
                    first ? cell(AW[0], p.name, { bold: true, vMerge: merge }) : cell(AW[0], "", { vMerge: merge, empty: true }),
                    cell(AW[1], it.topic),
                    cell(AW[2], it.action, { color: ACTION_TXT }),
                    cell(AW[3], it.owner),
                    cell(AW[4], isNone(it.blocker) ? "None" : it.blocker, { color: isNone(it.blocker) ? BODY_TXT : RED }),
                    first ? cell(AW[5], p.calls_held || "0", { center: true, vMerge: merge })
                          : cell(AW[5], "", { vMerge: merge, empty: true })
                ]
            }));
        });
    }
    children.push(table(AW, ["Project", "Topic", "Action Item", "Owner", "Blocker", "Calls Held"], actionRows));

    children.push(sectionHeading("Go-Live Status"));
    const GW = [2400, 2200, 1000, 4200, 4980];
    const goRows = projects.map((p) => {
        const g = p.go_live || {};
        const changed = Boolean(g.changed);
        return new TableRow({
            children: [
                cell(GW[0], p.name, { bold: true }),
                cell(GW[1], g.target || "TBD"),
                cell(GW[2], changed ? "Yes" : "No", { bold: true, center: true, color: changed ? RED : GREEN }),
                cell(GW[3], g.summary),
                cell(GW[4], g.next_week)
            ]
        });
    });
    children.push(table(GW, ["Project", "Target Go-Live", "Change in Go-Live", "Summary", "Next Week Plan"], goRows));

    return new Document({
        styles: { default: { document: { run: { font: FONT, size: 20 } } } },
        numbering: {
            config: [{
                reference: "bullets", levels: [{
                    level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
                    style: { paragraph: { indent: { left: 720, hanging: 360 } } }
                }]
            }]
        },
        sections: [{
            properties: {
                page: {
                    size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE },
                    margin: { top: 500, right: 500, bottom: 500, left: 500 }
                }
            },
            children
        }]
    });
}

// ============================================================
// RUN
// ============================================================

const w = warp.window.resolve(WINDOW);
const weekOfText = weekOfLabel(w);
const reportDateText = new Date(w.to - 1).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

console.log(`Week Of: ${weekOfText} | Report Date: ${reportDateText}`);

const activeByCustomer = await fetchActiveProjectsByCustomer();
console.log(`Found ${activeByCustomer.size} active customer(s).`);

const gongFiles = warp.gong.transcripts().filter(f => f.mtime >= w.from && f.mtime < w.to && f.group);
const gongGroups = [...new Set(gongFiles.map(f => f.group))];

const correlation = warp.correlate.customers(
    gongGroups.map(g => g.replace(/-/g, " ")),
    [...activeByCustomer.keys()],
    { minimum: "strong" }
);

// group -> matched customer name, so we can pull just that customer's files.
//
// core/correlate.js's matched[].gong and matched[].cxportal are the whole
// {name} objects it was given, not plain strings — comparing them directly
// against a string (an earlier version of this script did exactly that)
// is always false regardless of match quality, which is why every group
// used to show up "unmatched" even when the names were identical.
const groupToCustomer = new Map();
for (const m of correlation.matched) {
    const group = gongGroups.find(g => g.replace(/-/g, " ") === m.gong.name);
    if (group) groupToCustomer.set(group, m.cxportal.name);
}

// A Gong "group" folder is named from whatever Gong itself called the
// customer on that call (organize.js's plan() slugs the raw callCustomers
// field) — it is never checked against CX Portal's customerName. So a real,
// present transcript can still fail to reach `matched` here, silently, if
// correlate.js only scores it "weak" (below the `minimum: "strong"` floor)
// for a longer or punctuation-heavy legal name. Surface that instead of
// letting it look identical to "genuinely no calls this week".
const unmatchedGroups = gongGroups.filter(g => !groupToCustomer.has(g));
if (unmatchedGroups.length) {
    console.log(`  ! ${unmatchedGroups.length} gong group(s) had a transcript this week but did not match any active customer at "strong" confidence:`);
    for (const g of unmatchedGroups) {
        const near = correlation.review.find(r => r.gong.name === g.replace(/-/g, " "));
        console.log(
            `      "${g}"` +
            (near ? ` — closest guess: "${near.cxportal.name}" (${near.confidence}, score ${near.score})` : " — no candidate match at all")
        );
    }
}

const warpProjectsByCxpId = new Map(
    warp.projects.list().filter(p => p.cxpProjectId).map(p => [p.cxpProjectId, p])
);

const results = [];

for (const [customerName, projectRefs] of activeByCustomer) {

    const customerGongFiles = gongFiles.filter(f => groupToCustomer.get(f.group) === customerName);

    if (REQUIRE_CALLS_THIS_WEEK && !customerGongFiles.length) {
        results.push({ customer: customerName, status: "skipped-no-calls" });
        console.log(`  · ${customerName} — no calls this week, skipped`);
        continue;
    }

    try {

        // A representative Warp project's context.md, if this customer has
        // one, plus this week's raw transcripts — same file-scoping idea as
        // core/chat.js's "attach the project's context, not raw everything".
        const representative = projectRefs
            .map(ref => warpProjectsByCxpId.get(ref.cxpProjectId))
            .find(Boolean);

        const files = [
            ...(representative?.hasContext ? [warp.projects.get(representative.id)?.context?.path].filter(Boolean) : []),
            ...customerGongFiles.map(f => f.path)
        ];

        console.log(`  extracting ${customerName} (${files.length} file(s))...`);

        const data = await extractWsrData(customerName, weekOfText, reportDateText, files);
        const doc = buildWsrDocument(data);

        const saved = await warp.docx.save(doc, `${customerName}-WSR-${w.fromDay}-to-${w.toDay}`);

        const approval = await warp.approvals.propose({
            title: `${customerName} — Weekly Status Report (${weekOfText})`,
            path: saved.path,
            projectId: representative?.id || null
        });

        console.log(`  ✓ ${customerName} — ${saved.path}`);

        results.push({
            customer: customerName,
            status: "proposed",
            path: saved.path,
            approvalId: approval.id,
            projects: data.projects?.length ?? 0
        });

    } catch (error) {

        console.error(`  ! ${customerName} — ${error.message}`);
        results.push({ customer: customerName, status: "failed", error: error.message });
    }

    await new Promise(resolve => setTimeout(resolve, PACE_MS));
}

const proposed = results.filter(r => r.status === "proposed").length;
const skipped = results.filter(r => r.status === "skipped-no-calls").length;
const failed = results.filter(r => r.status === "failed").length;

console.log(`Done: ${proposed} WSR(s) proposed, ${skipped} skipped (no calls), ${failed} failed.`);

warp.notify.say(
    "Weekly Status Reports generated",
    `${proposed} WSR(s) ready for review, ${skipped} customer(s) had no calls this week, ${failed} failed.`
);

return { weekOf: weekOfText, results };
