// VALIDATION RULES
//   Summary › Project Status   key: project
//       new row when Status / Target Go-Live / Blocked On / JIRA changed
//   Summary › Change Log       key: project + old go-live + new go-live
//       only go-live changes newer than the last one already in the sheet
//   Summary › Executive Summary  regenerated only if a new go-live change
//       was appended; otherwise the existing text is kept
//   Project Plan (one per project)  key: milestone + task
//       new row when Status / Start / Finish / Go Live Date changed
//   Scoping                    a blank row is added only for a new project
//   Action Items tracker       existing rows kept (no fake items from notes)
//
// READING THE PREVIOUS FILE
//   warp.* has no sanctioned read. The script uses warp.excel.load(path) if
//   your platform adds one; otherwise it falls back to exceljs's own
//   workbook.xlsx.readFile(path). That is the same unsandboxed exceljs path
//   engine-api.md warns about for writeFile(). It is read-only here. Writing
//   still goes only through warp.excel.save().
// ============================================================================
 
 
// ============================================================
// 0. CONFIG
// ============================================================
 
const CONFIG = {
    // Limit the run to some customers (exact customerName); [] = all customers
    onlyCustomers: [],
 
    // Existing workbook per customer to validate against.
    // Paste the `path` each customer returned on the previous run, e.g.
    // { "RW Supply and Design, LLC": "/…/docs/customer-reports/rw-supply-….xlsx" }
    existingFiles: {},
    // If a customer isn't in existingFiles, look for its pending approval
    findExistingInApprovals: true,
 
    outputFolder: "customer-reports",
    saveWhenNoChanges: false,
    proposeForApproval: true,
    notifyWhenDone: true,
 
    changeLogMode: "all",          // "all" = every go-live change, "latest" = last one only
 
    // People line on the Summary sheet (not in the JSON). Per customer:
    // { "RW Supply and Design, LLC": { sdm, em, pco, cam, salesHandoffDate } }
    // Any value left out falls back to the CX Portal project row, then
    // (EM only) the most frequent note author, then "TBD".
    peopleByCustomer: {},
 
    // Budgeted hours per project (not in the JSON), keyed by displayId
    budgetedHoursByProject: {},    // e.g. { "PS-0238": 10 }
 
    pageSize: 200,
    maxPages: 20,
    delayBetweenProjectsMs: 150,
    delayBetweenCustomersMs: 250,
};
 
// Aquera's standard onboarding milestone/task template — matched against
// each project's real tasks by name (same as the previous script).
const MILESTONE_TEMPLATE = [
    ["M1", "Kickoff & Discovery", "Sales handoff, onboarding concierge, and kickoff calls"],
    ["M2", "Connectivity", "Connectivity Validation"],
    ["M3", "Integration Analysis", "Discovery & Solution Walkthrough"],
    ["M4", "Implementation & Configuration", "Configuration & Attribute Mapping"],
    ["M4", "Implementation & Configuration", "Group Rule Configuration"],
    ["M4", "Implementation & Configuration", "OU Mapping Configuration"],
    ["M4", "Implementation & Configuration", "Writeback configuration"],
    ["M4", "Implementation & Configuration", "Reporting Configuration"],
    ["M5", "Testing & UAT", "Execution with Test record"],
    ["M5", "Testing & UAT", "Validation & Report-Only Testing"],
    ["M5", "Testing & UAT", "Customer UAT"],
    ["M5", "Testing & UAT", "Controlled Execution of Live Records"],
    ["M6", "Go-Live", "Go-Live Cutover & Sign-off"],
    ["M6", "Go-Live", "Hypercare"],
    ["M7", "Handover to Support", "Documentation"],
    ["M7", "Handover to Support", "Training"],
];
 
 
// ============================================================
// 1. FORMAT CONSTANTS (taken from the reference workbook)
// ============================================================
 
const NAVY = "FF1F3864";
const GREY_TEXT = "FF404040";
const BORDER_GREY = "FFBFBFBF";
const INPUT_FILL = "FFFFF2CC";
const LIGHT_HDR_FILL = "FFD6DCE4";
 
const thin = { style: "thin", color: { argb: BORDER_GREY } };
const BORDER_ALL = { top: thin, left: thin, bottom: thin, right: thin };
const solid = argb => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
 
const FONT_TITLE   = { name: "Arial", size: 16, bold: true, color: { argb: NAVY } };
const FONT_SUB     = { name: "Arial", size: 10, color: { argb: GREY_TEXT } };
const FONT_SECTION = { name: "Arial", size: 12, bold: true, color: { argb: NAVY } };
const FONT_HDR     = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
const FONT_HDR_DK  = { name: "Arial", size: 10, bold: true, color: { argb: "FF000000" } };
const FONT_LABEL   = { name: "Arial", size: 10, bold: true };
const FONT_BODY    = { name: "Calibri", size: 11 };
const FONT_NOTE    = { name: "Arial", size: 9, color: { argb: "FF666666" } };
 
const FMT_SHORT_DATE = "d-mmm-yy";
const FMT_LONG_DATE  = "[$-809]dd mmmm yyyy;@";
 
const STATUS_COLORS = [
    { values: ["Complete", "Live", "Closed - Resolved", "Yes"],           fill: "FFC6EFCE", font: "FF1E7145" },
    { values: ["In Progress", "TBD", "High", "UAT"],                       fill: "FFFCE4B0", font: "FF9C5700" },
    { values: ["In Implementation", "Monitoring", "Medium", "Configured"], fill: "FFD9E8FB", font: "FF1F4E78" },
    { values: ["Not Started", "Not Yet Started", "No", "Low"],             fill: "FFE7E6E6", font: "FF595959" },
    { values: ["Blocked", "At Risk", "Open", "Critical"],                  fill: "FFF8CBCB", font: "FFB00020" },
];
 
const RUN_DATE_ISO = new Date().toISOString().slice(0, 10);
 
 
// ============================================================
// 2. HELPERS
// ============================================================
 
const isDateObj = v => Object.prototype.toString.call(v) === "[object Date]"; // cross-realm safe
const isIsoDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
const isoDay = v => (isIsoDate(v) ? v.slice(0, 10) : null);
 
function toExcelDate(v) {
    if (!isIsoDate(v)) return null;
    const [y, m, d] = v.slice(0, 10).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}
 
// ISO string -> real date cell; other text stays text; empty -> null
const dateCellValue = v => (v == null || v === "" ? null : isIsoDate(v) ? toExcelDate(v) : v);
 
function fmtDisplayDate(v) {
    const d = toExcelDate(v);
    if (!d) return v || "";
    const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
    return `${String(d.getUTCDate()).padStart(2, "0")}-${mon}-${d.getUTCFullYear()}`;
}
 
const capitalize = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const lowerFirst = s => (s ? s.charAt(0).toLowerCase() + s.slice(1) : "");
const norm = v => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const normId = v => String(v ?? "").replace(/\s+/g, "").toUpperCase();   // "PS - 0238" -> "PS-0238"
const same = (a, b) => norm(a) === norm(b);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
 
// Excel sheet names: <=31 chars, no : \ / ? * [ ], unique in the workbook.
// "/" becomes a space, as in the reference ("Project Plan - Paycor Entra ID").
function uniqueSheetName(rawName, usedNames) {
    const cleaned = String(rawName || "Sheet").replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim() || "Sheet";
    let candidate = cleaned.slice(0, 31);
    let suffix = 2;
    while (usedNames.has(candidate)) {
        const tail = ` (${suffix++})`;
        candidate = cleaned.slice(0, 31 - tail.length) + tail;
    }
    usedNames.add(candidate);
    return candidate;
}
 
const customerFileName = name => `${String(name || "Unknown-Customer").trim()}-Project-Report`;
const approvalTitleFor = name => `${name} — Project Report`;
 
// targetDateHistory arrives as Python-repr text: "{'owner': 'customer', ...}, {...}".
// Python uses "..." for strings that contain an apostrophe, so both quote styles are read.
function parseTargetDateHistory(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") return [value];
    const text = String(value);
    try { const p = JSON.parse(text); return Array.isArray(p) ? p : [p]; } catch (_) { /* python repr */ }
    const out = [];
    for (const block of text.match(/\{[^{}]*\}/g) || []) {
        const obj = {};
        const re = /'(\w+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
        let m;
        while ((m = re.exec(block))) obj[m[1]] = m[2] ?? m[3];
        if (obj.newDate) out.push(obj);
    }
    return out;
}
 
// Read a cell back as a plain value (ISO date string, number, text or null)
function readCell(cell) {
    let v = cell.value;
    if (v == null) return null;
    if (isDateObj(v)) return v.toISOString().slice(0, 10);
    if (typeof v === "object") {
        if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
        if ("result" in v) { v = v.result; return isDateObj(v) ? v.toISOString().slice(0, 10) : v ?? null; }
        if ("text" in v) return v.text;
        if ("error" in v) return null;
    }
    return typeof v === "string" && v.trim() === "" ? null : v;
}
 
function readNote(cell) {
    const n = cell.note;
    if (!n) return null;
    if (typeof n === "string") return n;
    if (Array.isArray(n.texts)) return n.texts.map(t => t.text).join("");
    return null;
}
 
 
// ============================================================
// 3. JSON -> PER-PROJECT MODEL
// ============================================================
 
function mapStationStatus(status) {
    switch (norm(status)) {
        case "not_started":
        case "queued":      return "Not Yet Started";
        case "in_progress": return "In Implementation";
        case "uat":         return "UAT";
        case "on_hold":
        case "blocked":     return "Blocked";
        case "complete":
        case "completed":
        case "done":        return "Live";
        default:            return status || "In Implementation";
    }
}
 
function mapTaskStatus(status) {
    switch (norm(status)) {
        case "closed":
        case "complete":
        case "completed":   return "Complete";
        case "open":
        case "in progress": return "In Progress";
        case "blocked":     return "Blocked";
        default:            return status || "Not Started";
    }
}
 
function findTask(tasks, name) {
    const target = norm(name);
    return tasks.find(task => {
        const taskName = norm(task.name);
        return taskName && (taskName === target || taskName.includes(target) || target.includes(taskName));
    });
}
 
// Go-live changes: ONLY audit logs that changed targetDate, for this project.
// targetDateHistory on the newest one fills gaps (the audit list is paginated).
function extractTargetDateChanges(data, projectId) {
    const logs = (data?.audit?.logs || [])
        .filter(l => l.entityType === "project" && (!l.projectId || l.projectId === projectId))
        .filter(l => (l.changes || []).some(c => c.field === "targetDate"))
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
 
    const byChangedAt = new Map();
 
    for (const log of logs) {
        const ch = Object.fromEntries((log.changes || []).map(c => [c.field, c]));
        const changedAt = ch.targetDateChangeDate?.newValue || log.timestamp;
        const history = parseTargetDateHistory(ch.targetDateHistory?.newValue);
        const h = history.find(x => x.changedAt === changedAt) ||
                  history.find(x => x.newDate === ch.targetDate.newValue);
        if (!ch.targetDate.newValue || ch.targetDate.oldValue === ch.targetDate.newValue) continue;
        byChangedAt.set(changedAt, {
            changedAt,
            oldDate: ch.targetDate.oldValue || h?.oldDate || "",
            newDate: ch.targetDate.newValue,
            reason: ch.targetDateChangeReason?.newValue || h?.reason || "",
            owner: ch.targetDateChangeOwner?.newValue || h?.owner || "",
        });
    }
 
    if (logs.length) {
        const newest = logs[logs.length - 1];
        const hist = parseTargetDateHistory((newest.changes.find(c => c.field === "targetDateHistory") || {}).newValue);
        for (const h of hist) {
            if (h.changedAt && !byChangedAt.has(h.changedAt) && h.oldDate !== h.newDate) {
                byChangedAt.set(h.changedAt, {
                    changedAt: h.changedAt, oldDate: h.oldDate || "", newDate: h.newDate,
                    reason: h.reason || "", owner: h.owner || "",
                });
            }
        }
    }
 
    return [...byChangedAt.values()].sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));
}
 
function buildProjectModel(ref, data) {
    const pid = ref.cxpProjectId;
    const projectLogs = (data?.audit?.logs || []).filter(l => !l.projectId || l.projectId === pid);
    const latestProjectLog = projectLogs
        .filter(l => l.projectName)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
 
    const changes = extractTargetDateChanges(data, pid);
    const latestChange = changes.at(-1) || null;
 
    const latestStation = (data?.stationAudit?.logs || [])
        .slice()
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .map(l => (l.changes || []).find(c => c.field === "status"))
        .find(Boolean);
 
    let jira = "NA";
    const j = data?.jira;
    if (Array.isArray(j) && j.length) jira = j.map(x => x.key || x.id || x).join(", ");
    else if (j && Array.isArray(j.issues) && j.issues.length) jira = j.issues.map(x => x.key || x.id).join(", ");
 
    const authors = {};
    (data?.notes?.notes || []).forEach(n => { if (n.author) authors[n.author] = (authors[n.author] || 0) + 1; });
 
    return {
        projectId: pid,
        displayId: ref.displayId || latestProjectLog?.projectDisplayId || "",
        name: latestProjectLog?.projectName || ref.name,
        row: ref.row || {},
        status: mapStationStatus(latestStation?.newValue),
        jira,
        changes: CONFIG.changeLogMode === "latest" && latestChange ? [latestChange] : changes,
        latestChange,
        targetGoLive: latestChange?.newDate || isoDay(ref.row?.targetDate) || null,
        blockedOn: capitalize(latestChange?.owner || ""),
        topAuthor: Object.entries(authors).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
        consumedHours: data?.taskAggs?.hours ?? "",
        tasks: (data?.tasks?.tasks || []).filter(t => !t.projectId || t.projectId === pid),
    };
}
 
function projectExecSummary(p) {
    const c = p.latestChange;
    if (!c) return `${p.name}: no go-live date change information was found.`;
    const reason = (c.reason || "the latest project delay").replace(/\.\s*$/, "");
    return `${p.name}: target go-live is now ${fmtDisplayDate(c.newDate)}` +
        (c.oldDate ? ` (moved from ${fmtDisplayDate(c.oldDate)})` : "") +
        `, pushed by ${lowerFirst(reason)}.` +
        (c.owner ? ` The delay is owned by the ${c.owner}.` : "");
}
 
function buildPlanRows(p) {
    const goLiveRowTask = "Go-Live Cutover & Sign-off";
    return MILESTONE_TEMPLATE.map(([milestone, milestoneName, taskName]) => {
        const task = findTask(p.tasks, taskName);
        const row = {
            milestone, milestoneName, task: taskName, status: "Not Started",
            owner: null, current: null, description: null,
            start: null, finish: null, daysTaken: null,
            goLive: taskName === goLiveRowTask ? p.targetGoLive : null,
        };
        if (task) {
            row.status = mapTaskStatus(task.status);
            row.owner = task.consultantName || task.assigneeName || null;
            row.current = task.description || null;
            row.start = isoDay(task.createdAt);
            if (norm(task.status) === "closed") row.finish = isoDay(task.updatedAt);
        }
        return row;
    });
}
 
 
// ============================================================
// 4. FRESH STATE FOR ONE CUSTOMER (what the JSON says right now)
// ============================================================
 
function buildFreshState(customerName, projects) {
    const cfgPeople = CONFIG.peopleByCustomer[customerName] || {};
    const firstRow = projects[0]?.row || {};
    const pick = (cfgVal, ...rowVals) => cfgVal || rowVals.find(Boolean) || "TBD";
 
    const people = {
        sdm: pick(cfgPeople.sdm, firstRow.sdmName),
        em:  pick(cfgPeople.em, firstRow.emName, firstRow.epmName, firstRow.consultantName, projects[0]?.topAuthor),
        pco: pick(cfgPeople.pco, firstRow.pcoName),
        cam: pick(cfgPeople.cam, firstRow.camName),
        salesHandoffDate: pick(cfgPeople.salesHandoffDate,
            firstRow.salesHandoffDate ? fmtDisplayDate(isoDay(firstRow.salesHandoffDate)) : null),
    };
 
    const usedNames = new Set(["Summary", "Scoping", "Action Items tracker", "Lists"]);
 
    return {
        summaryTitle: `${customerName} -- Program Executive Summary`,
        peopleLine: `SDM: ${people.sdm} | EM: ${people.em} | PCO: ${people.pco}  |CAM: ${people.cam} |  Sales handoff Date: ${people.salesHandoffDate} `,
 
        statusRows: projects.map(p => ({
            project: p.name, status: p.status, goLive: p.targetGoLive,
            blockedOn: p.blockedOn, dateOfBlocker: null, jira: p.jira,
        })),
 
        changeLog: projects.flatMap(p => p.changes.map(c => ({
            project: p.name,
            oldDate: isoDay(c.oldDate),
            newDate: isoDay(c.newDate),
            reason: `${c.owner ? `Owner: ${capitalize(c.owner)}. ` : ""}${c.reason || ""}`.trim(),
        }))),
 
        execSummary: projects.map(projectExecSummary).join("\n\n"),
 
        // No structured scope data in projectDetail(): one blank row per project
        scopeIn:  projects.map(p => ({ project: p.name, _placeholder: true })),
        scopeOut: projects.map(p => ({ project: p.name, _placeholder: true })),
 
        plans: projects.map(p => ({
            displayId: p.displayId,
            projectName: p.name,
            sheetName: uniqueSheetName(`Project Plan - ${p.name}`, usedNames),
            title: `${customerName} -- Milestone Tracker`,
            header:
                `Use Case: ${p.name}   |   PS Tracker ID: ${(p.displayId || "N/A").replace("-", " - ")}   |   ` +
                `Budgeted Hours: ${CONFIG.budgetedHoursByProject[p.displayId] ?? p.row.budgetHours ?? p.row.budgetedHours ?? ""}   |   ` +
                `Consumed Hours: ${p.consumedHours}`,
            rows: buildPlanRows(p),
        })),
 
        // Do NOT invent action items from notes
        actions: [],
 
        useCases: projects.map(p => p.name),
    };
}
 
 
// ============================================================
// 5. READ AN EXISTING CUSTOMER WORKBOOK BACK INTO THE SAME SHAPE
// ============================================================
 
async function locateExistingFile(customerName) {
    if (CONFIG.existingFiles[customerName]) return CONFIG.existingFiles[customerName];
    if (!CONFIG.findExistingInApprovals) return null;
    const title = approvalTitleFor(customerName);
    const hit = (warp.approvals.pending() || []).find(a => a.path && String(a.title || "").startsWith(title));
    return hit ? hit.path : null;
}
 
async function loadWorkbook(path) {
    if (warp.excel.load) return await warp.excel.load(path);   // sanctioned read, if added later
    const wb = new warp.excel.Workbook();                        // fallback: exceljs read (read-only)
    await wb.xlsx.readFile(path);
    return wb;
}
 
function findRow(ws, col, text, from = 1) {
    for (let r = from; r <= ws.rowCount; r++) {
        if (same(readCell(ws.getCell(`${col}${r}`)), text)) return r;
    }
    return null;
}
 
function collectRows(ws, start, stopCol, mapFn, stopLabels = []) {
    const out = [];
    for (let r = start; r <= ws.rowCount; r++) {
        const k = readCell(ws.getCell(`${stopCol}${r}`));
        if (k == null || stopLabels.some(s => same(k, s))) break;
        out.push(mapFn(r));
    }
    return out;
}
 
function extractState(wb) {
    const st = { statusRows: [], changeLog: [], execSummary: null, scopeIn: [], scopeOut: [], plans: [], actions: [], useCases: [] };
    const g = (ws, a) => readCell(ws.getCell(a));
 
    const sum = wb.getWorksheet("Summary");
    if (sum) {
        const ps = findRow(sum, "B", "Project Status");
        if (ps) st.statusRows = collectRows(sum, ps + 2, "B", r => ({
            project: g(sum, `B${r}`), status: g(sum, `C${r}`), goLive: g(sum, `D${r}`),
            blockedOn: g(sum, `G${r}`), dateOfBlocker: g(sum, `H${r}`), jira: g(sum, `I${r}`),
            _note: readNote(sum.getCell(`B${r}`)),
        }), ["Change Log for Go Live"]);
 
        const cl = findRow(sum, "B", "Change Log for Go Live");
        if (cl) st.changeLog = collectRows(sum, cl + 2, "B", r => ({
            project: g(sum, `B${r}`), oldDate: g(sum, `C${r}`), newDate: g(sum, `D${r}`),
            reason: g(sum, `E${r}`), _note: readNote(sum.getCell(`B${r}`)),
        }), ["Executive Summary"]);
 
        const es = findRow(sum, "B", "Executive Summary");
        if (es) st.execSummary = g(sum, `B${es + 1}`);
    }
 
    const sc = wb.getWorksheet("Scoping");
    if (sc) {
        const ins = findRow(sc, "B", "In Scope");
        if (ins) st.scopeIn = collectRows(sc, ins + 2, "B", r => ({
            project: g(sc, `B${r}`), no: g(sc, `C${r}`), useCase: g(sc, `D${r}`),
            customScripts: g(sc, `E${r}`), status: g(sc, `F${r}`), _note: readNote(sc.getCell(`B${r}`)),
        }), ["Out Of Scope: Change Log"]);
 
        const outs = findRow(sc, "B", "Out Of Scope: Change Log");
        if (outs) st.scopeOut = collectRows(sc, outs + 2, "B", r => ({
            project: g(sc, `B${r}`), crId: g(sc, `C${r}`), useCase: g(sc, `D${r}`),
            description: g(sc, `E${r}`), dateAdded: g(sc, `F${r}`), extraHours: g(sc, `G${r}`),
            status: g(sc, `H${r}`), _note: readNote(sc.getCell(`B${r}`)),
        }));
    }
 
    for (const pl of wb.worksheets.filter(w => w.name.startsWith("Project Plan"))) {
        const header = String(g(pl, "A2") || "");
        const idMatch = header.match(/PS Tracker ID:\s*([^|]+)/i);
        const useCaseMatch = header.match(/Use Case:\s*([^|]+)/i);
        const hdr = findRow(pl, "A", "Milestone");
        let curId = null, curName = null;
        st.plans.push({
            displayId: idMatch ? normId(idMatch[1]) : "",
            projectName: useCaseMatch ? useCaseMatch[1].trim() : "",
            sheetName: pl.name,
            title: g(pl, "A1"),
            header,
            rows: hdr ? collectRows(pl, hdr + 1, "C", r => {
                if (g(pl, `A${r}`)) curId = g(pl, `A${r}`);
                if (g(pl, `B${r}`)) curName = g(pl, `B${r}`);
                return {
                    milestone: curId, milestoneName: curName, task: g(pl, `C${r}`), status: g(pl, `D${r}`),
                    owner: g(pl, `E${r}`), current: g(pl, `F${r}`), description: g(pl, `G${r}`),
                    start: g(pl, `H${r}`), finish: g(pl, `I${r}`), daysTaken: g(pl, `J${r}`),
                    goLive: g(pl, `K${r}`), _note: readNote(pl.getCell(`C${r}`)),
                };
            }) : [],
        });
    }
 
    const ai = wb.getWorksheet("Action Items tracker");
    if (ai) {
        const hdr = findRow(ai, "A", "#");
        if (hdr) st.actions = collectRows(ai, hdr + 1, "C", r => ({
            no: g(ai, `A${r}`), useCase: g(ai, `B${r}`), item: g(ai, `C${r}`), owner: g(ai, `D${r}`),
            status: g(ai, `E${r}`), raised: g(ai, `F${r}`), target: g(ai, `G${r}`), closed: g(ai, `H${r}`),
            note: g(ai, `I${r}`), _note: readNote(ai.getCell(`A${r}`)),
        }));
    }
 
    const lists = wb.getWorksheet("Lists");
    if (lists) {
        for (let r = 1; r <= lists.rowCount; r++) {
            const v = g(lists, `A${r}`);
            if (v && !same(v, "All Use Cases")) st.useCases.push(v);
        }
    }
    return st;
}
 
 
// ============================================================
// 6. VALIDATE + MERGE (existing rows first, new/changed below)
// ============================================================
 
function createMerger(report) {
    const addedNote = why => `Added by script on ${fmtDisplayDate(RUN_DATE_ISO)} — ${why}`;
 
    // Snapshot tables: new row when a tracked field differs from the LATEST row with that key
    function mergeOnChange(table, existing, fresh, keyFn, fields, labelFn) {
        const out = existing.slice();
        for (const f of fresh) {
            const prev = [...out].reverse().find(e => keyFn(e) === keyFn(f));
            if (!prev) {
                out.push({ ...f, _note: addedNote("new row") });
                report.push({ table, action: "added", detail: labelFn(f) });
                continue;
            }
            const diffs = fields.filter(k => !same(prev[k], f[k])).map(k => `${k}: ${prev[k] ?? "—"} → ${f[k] ?? "—"}`);
            if (diffs.length) {
                // carry over everything the JSON doesn't own (manual owner, notes, dates …)
                const merged = { ...prev, ...Object.fromEntries(fields.map(k => [k, f[k]])) };
                merged._note = addedNote(`changed (${diffs.join("; ")})`);
                out.push(merged);
                report.push({ table, action: "changed", detail: `${labelFn(f)} — ${diffs.join("; ")}` });
            }
        }
        return out;
    }
 
    // Change log: per project, only changes newer than the last one already in the sheet
    function mergeChangeLog(existing, fresh) {
        const out = existing.slice();
        const matches = (e, f) => same(e.project, f.project) && same(e.newDate, f.newDate) &&
            (!e.oldDate || !f.oldDate || same(e.oldDate, f.oldDate));
 
        const projects = [...new Set(fresh.map(f => norm(f.project)))];
        for (const pk of projects) {
            const freshP = fresh.filter(f => norm(f.project) === pk);
            const existingP = existing.filter(e => norm(e.project) === pk);
            let lastMatched = -1;
            freshP.forEach((f, i) => { if (existingP.some(e => matches(e, f))) lastMatched = i; });
            const candidates = existingP.length ? freshP.slice(lastMatched + 1) : freshP;
            for (const f of candidates) {
                if (out.some(e => matches(e, f))) continue;
                out.push({ ...f, _note: addedNote("new go-live change from audit log") });
                report.push({ table: "Summary › Change Log", action: "added",
                    detail: `${f.project}: ${f.oldDate || "—"} → ${f.newDate}` });
            }
        }
        return out;
    }
 
    // Scoping: add a blank row only for a project that has no row yet
    function mergeScope(table, existing, fresh) {
        const out = existing.slice();
        for (const f of fresh) {
            if (out.some(e => same(e.project, f.project))) continue;
            out.push({ ...f, _note: addedNote("new project") });
            report.push({ table, action: "added", detail: f.project });
        }
        return out;
    }
 
    function mergePlans(existingPlans, freshPlans) {
        const out = existingPlans.map(p => ({ ...p }));          // keep every existing plan sheet
        for (const fp of freshPlans) {
            const ep = out.find(p =>
                (fp.displayId && normId(p.displayId) === normId(fp.displayId)) ||
                (!p.displayId && same(p.projectName, fp.projectName)));
            if (!ep) {
                out.push({ ...fp, rows: fp.rows.map(r => ({ ...r })), _new: true });
                report.push({ table: "Project Plan", action: "added", detail: `new sheet for ${fp.projectName}` });
                continue;
            }
            ep.title = fp.title;
            ep.header = fp.header;                              // header line refreshed (consumed hours)
            ep.rows = mergeOnChange(`Project Plan › ${fp.projectName}`, ep.rows, fp.rows,
                r => `${norm(r.milestone)}|${norm(r.task)}`,
                ["status", "start", "finish", "goLive"],
                r => `${r.milestone} ${r.task}`);
        }
        return out;
    }
 
    return { addedNote, mergeOnChange, mergeChangeLog, mergeScope, mergePlans };
}
 
function mergeStates(existing, fresh, report) {
    if (!existing) return { ...fresh, _firstRun: true };
 
    const M = createMerger(report);
    const changeLog = M.mergeChangeLog(existing.changeLog, fresh.changeLog);
    const newGoLive = changeLog.length > existing.changeLog.length;
 
    return {
        summaryTitle: fresh.summaryTitle,
        peopleLine: fresh.peopleLine,
        statusRows: M.mergeOnChange("Summary › Project Status", existing.statusRows, fresh.statusRows,
            r => norm(r.project), ["status", "goLive", "blockedOn", "jira"], r => r.project),
        changeLog,
        execSummary: newGoLive || !existing.execSummary ? fresh.execSummary : existing.execSummary,
        _execSummaryRefreshed: newGoLive,
        scopeIn: M.mergeScope("Scoping › In Scope", existing.scopeIn, fresh.scopeIn),
        scopeOut: M.mergeScope("Scoping › Out Of Scope", existing.scopeOut, fresh.scopeOut),
        plans: M.mergePlans(existing.plans, fresh.plans),
        actions: existing.actions,
        useCases: [...new Set([...existing.useCases, ...fresh.useCases])],
    };
}
 
 
// ============================================================
// 7. SHEET WRITERS — reference workbook format
// ============================================================
 
function writeHeaderRow(ws, rowNum, startCol, headers, dark = true) {
    headers.forEach((h, i) => {
        const cell = ws.getRow(rowNum).getCell(startCol + i);
        cell.value = h;
        cell.font = dark ? FONT_HDR : FONT_HDR_DK;
        cell.fill = solid(dark ? NAVY : LIGHT_HDR_FILL);
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.border = BORDER_ALL;
    });
}
 
function bodyCell(cell, value, { center = false, wrap = false, bold = false, fill = null, numFmt = null } = {}) {
    cell.value = value === undefined ? null : value;
    cell.font = bold ? FONT_LABEL : FONT_BODY;
    cell.border = BORDER_ALL;
    cell.alignment = { vertical: "top", horizontal: center ? "center" : undefined, wrapText: wrap || undefined };
    if (fill) cell.fill = solid(fill);
    if (numFmt) cell.numFmt = numFmt;
}
 
const setNote = (cell, text) => { if (text) cell.note = text; };
 
function titleCell(ws, range, text, font, height, rowNum) {
    ws.mergeCells(range);
    const cell = ws.getCell(range.split(":")[0]);
    cell.value = text;
    cell.font = font;
    ws.getRow(rowNum).height = height;
}
 
function setWidths(ws, widths) {
    Object.entries(widths).forEach(([col, w]) => { ws.getColumn(col).width = w; });
}
 
function addStatusCF(ws, ref) {
    const rules = [];
    let priority = 1;
    for (const grp of STATUS_COLORS) {
        for (const v of grp.values) {
            rules.push({
                type: "cellIs", operator: "equal", formulae: [`"${v}"`], priority: priority++,
                style: {
                    fill: { type: "pattern", pattern: "solid", bgColor: { argb: grp.fill } },
                    font: { color: { argb: grp.font } },
                },
            });
        }
    }
    ws.addConditionalFormatting({ ref, rules });
}
 
function estimateLines(text, charsPerLine) {
    return String(text || "").split("\n")
        .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
}
 
// ---- Summary -------------------------------------------------------------
 
function writeSummary(wb, s) {
    const ws = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 3, showGridLines: false }] });
    setWidths(ws, { B: 30, C: 16, D: 15, E: 57.83, G: 15, H: 15, I: 15 });
 
    titleCell(ws, "B1:I1", s.summaryTitle, FONT_TITLE, 30, 1);
    titleCell(ws, "B2:I2", s.peopleLine, FONT_SUB, 15.75, 2);
 
    ws.getCell("B4").value = "Project Status"; ws.getCell("B4").font = FONT_SECTION;
    ws.getCell("G4").value = "Blocker Table";  ws.getCell("G4").font = FONT_SECTION;
    ws.getRow(4).height = 19.5;
    writeHeaderRow(ws, 5, 2, ["Projects", "Status", "Target Go-Live"]);
    writeHeaderRow(ws, 5, 7, ["Blocked On", "Date of Blocker", "JIRA"]);
    ws.getRow(5).height = 27.75;
 
    let row = 6;
    for (const r of s.statusRows) {
        const x = ws.getRow(row);
        bodyCell(x.getCell("B"), r.project, { bold: true });
        bodyCell(x.getCell("C"), r.status, { center: true });
        bodyCell(x.getCell("D"), dateCellValue(r.goLive), { center: true, numFmt: FMT_SHORT_DATE });
        bodyCell(x.getCell("G"), r.blockedOn || null);
        bodyCell(x.getCell("H"), dateCellValue(r.dateOfBlocker), { center: true, numFmt: FMT_SHORT_DATE });
        bodyCell(x.getCell("I"), r.jira || "NA", { center: true });
        setNote(x.getCell("B"), r._note);
        row++;
    }
    addStatusCF(ws, `C6:C${Math.max(row - 1, 6) + 5}`);
 
    const clHdr = Math.max(row + 1, 8);
    ws.getCell(`B${clHdr}`).value = "Change Log for Go Live"; ws.getCell(`B${clHdr}`).font = FONT_SECTION;
    ws.getRow(clHdr).height = 19.5;
    writeHeaderRow(ws, clHdr + 1, 2, ["Project", "Estimated Go Live", "Updated Go Live", "Reason for Slippage"]);
    ws.getRow(clHdr + 1).height = 27.75;
 
    row = clHdr + 2;
    for (const c of (s.changeLog.length ? s.changeLog : [{}])) {
        const x = ws.getRow(row);
        bodyCell(x.getCell("B"), c.project || null);
        bodyCell(x.getCell("C"), dateCellValue(c.oldDate), { center: true, numFmt: FMT_SHORT_DATE });
        bodyCell(x.getCell("D"), dateCellValue(c.newDate), { center: true, numFmt: FMT_SHORT_DATE });
        bodyCell(x.getCell("E"), c.reason || null, { wrap: true });
        setNote(x.getCell("B"), c._note);
        x.height = c.reason ? Math.max(15, estimateLines(c.reason, 60) * 16.5) : 15;
        row++;
    }
 
    const esHdr = row + 1;
    ws.getCell(`B${esHdr}`).value = "Executive Summary"; ws.getCell(`B${esHdr}`).font = FONT_SECTION;
    ws.getRow(esHdr).height = 16;
    ws.mergeCells(`B${esHdr + 1}:I${esHdr + 6}`);
    const es = ws.getCell(`B${esHdr + 1}`);
    es.value = s.execSummary || "";
    es.font = { name: "Arial", size: 10 };
    es.fill = solid(INPUT_FILL);
    es.alignment = { vertical: "top", wrapText: true };
    es.border = BORDER_ALL;
    if (s._execSummaryRefreshed) setNote(es, `Added by script on ${fmtDisplayDate(RUN_DATE_ISO)} — regenerated after new go-live change`);
    // B:I is ~165 chars wide at Arial 10; spread the needed height over the 6 merged rows
    const perRow = Math.max(15, Math.ceil((estimateLines(s.execSummary, 150) * 13) / 6));
    for (let r = esHdr + 1; r <= esHdr + 6; r++) ws.getRow(r).height = perRow;
}
 
// ---- Scoping -------------------------------------------------------------
 
function writeScoping(wb, s) {
    const ws = wb.addWorksheet("Scoping", { views: [{ state: "frozen", ySplit: 3, showGridLines: false }] });
    setWidths(ws, { B: 15.83, C: 5.83, D: 12.5, E: 20.66, F: 11, G: 18.83, H: 13, I: 17, J: 46 });
 
    titleCell(ws, "B1:J1", "Scoping Document", FONT_TITLE, 30, 1);
    titleCell(ws, "B2:J2", "Lifecycle Events in Scope, by Use Case", FONT_SUB, 15.75, 2);
    ws.getRow(3).height = 3;
 
    ws.getCell("B4").value = "In Scope"; ws.getCell("B4").font = FONT_SECTION; ws.getRow(4).height = 31.5;
    writeHeaderRow(ws, 5, 2, ["Project", "#", "Use case", "Custom Scripts (Y/N)", "Status"], false);
 
    let row = 6;
    for (const r of s.scopeIn) {
        const x = ws.getRow(row);
        bodyCell(x.getCell("B"), r.project, { bold: true });
        bodyCell(x.getCell("C"), r.no ?? null, { center: true });
        bodyCell(x.getCell("D"), r.useCase ?? null);
        bodyCell(x.getCell("E"), r.customScripts ?? null, { center: true });
        bodyCell(x.getCell("F"), r.status ?? null, { center: true });
        setNote(x.getCell("B"), r._note);
        row++;
    }
    addStatusCF(ws, `F6:F${Math.max(row - 1, 6)}`);
 
    const outHdr = Math.max(row + 3, 13);
    ws.getCell(`B${outHdr}`).value = "Out Of Scope: Change Log"; ws.getCell(`B${outHdr}`).font = FONT_SECTION;
    ws.getRow(outHdr).height = 16;
    writeHeaderRow(ws, outHdr + 1, 2,
        ["Project", "CR ID", "Use case", "Description", "Date Added", "Extra Hours Needed", "Status"], false);
 
    let orow = outHdr + 2;
    for (const o of s.scopeOut) {
        const x = ws.getRow(orow);
        bodyCell(x.getCell("B"), o.project, { bold: true });
        if (!o._placeholder) {
            bodyCell(x.getCell("C"), o.crId ?? null, { center: true });
            bodyCell(x.getCell("D"), o.useCase ?? null);
            bodyCell(x.getCell("E"), o.description ?? null, { wrap: true });
            bodyCell(x.getCell("F"), dateCellValue(o.dateAdded), { center: true, numFmt: FMT_SHORT_DATE });
            bodyCell(x.getCell("G"), o.extraHours ?? null, { center: true });
            bodyCell(x.getCell("H"), o.status ?? null, { center: true });
        }
        setNote(x.getCell("B"), o._note);
        orow++;
    }
    addStatusCF(ws, `H${outHdr + 2}:H${Math.max(orow - 1, outHdr + 2)}`);
}
 
// ---- Project Plan (one per project) -------------------------------------
 
function writeProjectPlan(wb, plan) {
    const ws = wb.addWorksheet(plan.sheetName);
    setWidths(ws, { A: 11, B: 26.66, C: 34, D: 13, E: 22, F: 30, G: 40, H: 19.33, I: 16, J: 12, K: 15 });
 
    titleCell(ws, "A1:K1", plan.title, FONT_TITLE, 20, 1);
    titleCell(ws, "A2:K2", plan.header, FONT_SUB, 15.75, 2);
 
    writeHeaderRow(ws, 4, 1, ["Milestone", "Milestone Name", "Task", "Status", "Owner", "Current Status",
        "Dependencies / Description", "Start Date", "Finish Date", "Days Taken", "Go Live Date"]);
 
    let row = 5, prevMs = null;
    for (const t of plan.rows) {
        const x = ws.getRow(row);
        const first = norm(t.milestone) !== norm(prevMs);   // milestone label only on first row of a group
        bodyCell(x.getCell("A"), first ? t.milestone : null, { bold: true });
        bodyCell(x.getCell("B"), first ? t.milestoneName : null, { bold: true });
        bodyCell(x.getCell("C"), t.task, { wrap: true, fill: INPUT_FILL });
        bodyCell(x.getCell("D"), t.status ?? null, { center: true, fill: INPUT_FILL });
        bodyCell(x.getCell("E"), t.owner ?? null, { wrap: true, fill: INPUT_FILL });
        bodyCell(x.getCell("F"), t.current ?? null, { wrap: true, fill: INPUT_FILL });
        bodyCell(x.getCell("G"), t.description ?? null, { wrap: true, fill: INPUT_FILL });
        bodyCell(x.getCell("H"), dateCellValue(t.start), { center: true, fill: INPUT_FILL, numFmt: FMT_LONG_DATE });
        bodyCell(x.getCell("I"), dateCellValue(t.finish), { center: true, fill: INPUT_FILL, numFmt: FMT_LONG_DATE });
        // Days Taken = Finish - Start when both are real dates, else keep what was there
        const days = isIsoDate(t.start) && isIsoDate(t.finish)
            ? { formula: `IF(AND(ISNUMBER(H${row}),ISNUMBER(I${row})),I${row}-H${row},"TBD")` }
            : (t.daysTaken ?? null);
        bodyCell(x.getCell("J"), days, { center: true, numFmt: "0" });
        bodyCell(x.getCell("K"), dateCellValue(t.goLive), { center: true, numFmt: FMT_LONG_DATE });
        setNote(x.getCell("C"), t._note);
        const longest = Math.max(...[t.task, t.owner, t.current].map(v => String(v || "").length));
        x.height = longest > 60 ? 48 : longest > 28 ? 32 : 16;
        prevMs = t.milestone;
        row++;
    }
    const lastRow = Math.max(row - 1, 5);
 
    ws.dataValidations.add(`D5:D${lastRow}`, {
        type: "list", allowBlank: true, formulae: ['"Complete,In Progress,Not Started,Blocked,At Risk"'],
    });
    addStatusCF(ws, `D5:D${lastRow + 7}`);
 
    const blank = Math.max(lastRow + 9, 29);
    ws.mergeCells(`A${blank}:K${blank + 1}`);
    const noteRow = blank + 3;
    ws.mergeCells(`A${noteRow}:K${noteRow + 1}`);
    const note = ws.getCell(`A${noteRow}`);
    note.value =
        "Note: Start Date = previous milestone's Finish Date (assumes milestones run back-to-back with no gap). " +
        "M1's Start Date is the actual sales-handoff date recorded in its Description field. Days Taken = Finish Date " +
        "minus Start Date, shown only where both are specific calendar dates (shows \"TBD\" where a date is still a " +
        "range, e.g. M1's \"Apr-May 2026\", or not yet set).";
    note.font = FONT_NOTE;
    note.fill = solid(INPUT_FILL);
    note.alignment = { vertical: "top", wrapText: true };
    ws.getRow(noteRow).height = 15;
    ws.getRow(noteRow + 1).height = 15;
}
 
// ---- Action Items --------------------------------------------------------
 
function writeActionItems(wb, s, useCaseCount) {
    const ws = wb.addWorksheet("Action Items tracker", { views: [{ state: "frozen", ySplit: 4, showGridLines: false }] });
    setWidths(ws, { A: 6, B: 37.33, C: 46, D: 22, E: 13, F: 12, G: 12, H: 12, I: 60 });
 
    titleCell(ws, "A1:I1", "Action Item Tracker", FONT_TITLE, 30, 1);
    titleCell(ws, "A2:I2",
        "After every customer call: pick your project from the Use Case dropdown, log the action item and owner, " +
        "set Status, and set the Due Date. Use the filter arrow on the Use Case column header to see only your project's items.",
        FONT_SUB, 15.75, 2);
 
    writeHeaderRow(ws, 4, 1, ["#", "Use Case", "Action Item", "Owner", "Status",
        "Date Raised", "Target Date", "Date Closed", "Note"]);
    ws.getRow(4).height = 27.75;
 
    let row = 5;
    for (const a of s.actions) {
        const x = ws.getRow(row);
        bodyCell(x.getCell("A"), a.no ?? row - 4);
        bodyCell(x.getCell("B"), a.useCase);
        bodyCell(x.getCell("C"), a.item);
        bodyCell(x.getCell("D"), a.owner);
        bodyCell(x.getCell("E"), a.status);
        bodyCell(x.getCell("F"), dateCellValue(a.raised), { numFmt: FMT_SHORT_DATE });
        bodyCell(x.getCell("G"), dateCellValue(a.target), { numFmt: FMT_SHORT_DATE });
        bodyCell(x.getCell("H"), dateCellValue(a.closed), { numFmt: FMT_SHORT_DATE });
        bodyCell(x.getCell("I"), a.note);
        setNote(x.getCell("A"), a._note);
        x.height = 27.75;
        row++;
    }
 
    // The dropdowns the A2 instructions refer to
    ws.dataValidations.add("B5:B500", {
        type: "list", allowBlank: true, formulae: [`Lists!$A$1:$A$${useCaseCount + 1}`],
    });
    ws.dataValidations.add("E5:E500", {
        type: "list", allowBlank: true, formulae: ['"Open,In Progress,Blocked,Closed"'],
    });
    addStatusCF(ws, "E5:E500");
    ws.autoFilter = `A4:I${Math.max(row - 1, 5)}`;
}
 
// ---- Lists (hidden) --------------------------------------------------------
 
function writeLists(wb, useCases) {
    const ws = wb.addWorksheet("Lists", { state: "hidden" });
    [
        [...useCases, "All Use Cases"],
        ["Live", "In Implementation", "In Progress", "UAT", "Not Yet Started"],
        ["Complete", "In Progress", "Not Started", "Blocked", "At Risk"],
        ["Open", "In Progress", "Complete", "Blocked"],
        ["Risk", "Assumption", "Issue", "Dependency"],
        ["Critical", "High", "Medium", "Low"],
        ["Open", "Monitoring", "Closed - Resolved"],
        ["Yes", "No", "TBD", "NA"],
        ["Y", "N"],
    ].forEach((vals, c) => vals.forEach((v, r) => {
        const cell = ws.getRow(r + 1).getCell(c + 1);
        cell.value = v;
        cell.font = FONT_BODY;
    }));
}
 
 
// ============================================================
// 8. FETCH ACTIVE PROJECTS, GROUPED BY CUSTOMER
// ============================================================
 
async function fetchActiveProjectsByCustomer() {
    const rows = [];
    let cursor = null;
    let total = Infinity;
 
    for (let page = 0; page < CONFIG.maxPages && rows.length < total; page++) {
        const result = await warp.cxp.myProjects({ size: CONFIG.pageSize, cursor, hideClosed: true });
        rows.push(...(result.projects || []));
        total = result.total ?? rows.length;
        cursor = result.nextCursor || null;      // echoed back verbatim
        if (!cursor) break;
    }
 
    const byCustomer = new Map();
    for (const row of rows) {
        const cxpProjectId = row.projectId || row.displayId;
        if (!cxpProjectId) continue;
        const customerName = row.customerName || row.name || "Unknown Customer";
        if (CONFIG.onlyCustomers.length && !CONFIG.onlyCustomers.includes(customerName)) continue;
        if (!byCustomer.has(customerName)) byCustomer.set(customerName, []);
        byCustomer.get(customerName).push({
            cxpProjectId,
            displayId: row.displayId || null,
            name: row.name || row.displayId || cxpProjectId,
            row,
        });
    }
    return byCustomer;
}
 
 
// ============================================================
// 9. ONE CUSTOMER: fetch -> validate -> build -> save -> propose
// ============================================================
 
async function processCustomer(customerName, refs) {
    // THE AWAIT CALL: one projectDetail() per active project, paced
    const projects = [];
    for (const ref of refs) {
        const data = await warp.cxp.projectDetail(ref.cxpProjectId, { displayId: ref.displayId, name: ref.name });
        projects.push(buildProjectModel(ref, data));
        await sleep(CONFIG.delayBetweenProjectsMs);
    }
 
    const fresh = buildFreshState(customerName, projects);
 
    const existingPath = await locateExistingFile(customerName);
    let existing = null;
    if (existingPath) {
        try {
            existing = extractState(await loadWorkbook(existingPath));
            console.log(`[${customerName}] validating against ${existingPath}`);
        } catch (e) {
            // fail this customer loudly rather than rebuild and lose manual edits
            throw new Error(`could not read existing workbook ${existingPath}: ${e.message}`);
        }
    }
 
    const report = [];
    const state = mergeStates(existing, fresh, report);
    report.forEach(r => console.log(`[${customerName}] ${r.table} ${r.action}: ${r.detail}`));
 
    if (!state._firstRun && !report.length && !CONFIG.saveWhenNoChanges) {
        console.log(`[${customerName}] no new or changed rows — left as is`);
        return { customer: customerName, status: "unchanged", path: existingPath, validation: [] };
    }
 
    const wb = new warp.excel.Workbook();
    wb.creator = "Project Report Generator";
    wb.created = new Date();
    wb.modified = new Date();
 
    writeSummary(wb, state);
    writeScoping(wb, state);
    for (const plan of state.plans) writeProjectPlan(wb, plan);
    writeActionItems(wb, state, state.useCases.length);
    writeLists(wb, state.useCases);
 
    // Only sanctioned write path — never workbook.xlsx.writeFile()
    const saved = await warp.excel.save(wb, customerFileName(customerName),
        CONFIG.outputFolder ? { folder: CONFIG.outputFolder } : undefined);
    console.log(`[${customerName}] saved ${saved.path}`);
 
    const approval = CONFIG.proposeForApproval
        ? await warp.approvals.propose({
            title: `${approvalTitleFor(customerName)} (${projects.length} active project${projects.length === 1 ? "" : "s"})`,
            path: saved.path,
        })
        : null;
 
    return {
        customer: customerName,
        status: state._firstRun ? "created" : "updated",
        activeProjects: projects.map(p => p.displayId || p.projectId),
        path: saved.path,
        approvalId: approval ? approval.id : null,
        validation: report,
    };
}
 
 
// ============================================================
// 10. RUN
// ============================================================
 
const byCustomer = await fetchActiveProjectsByCustomer();
console.log(`Found ${byCustomer.size} customer(s) with at least one active project.`);
 
const results = [];
for (const [customerName, refs] of byCustomer) {
    try {
        results.push(await processCustomer(customerName, refs));
    } catch (error) {
        console.error(`Failed to build workbook for ${customerName}: ${error.message}`);
        results.push({ customer: customerName, status: "failed", error: error.message });
    }
    await sleep(CONFIG.delayBetweenCustomersMs);
}
 
const count = s => results.filter(r => r.status === s).length;
const summaryLine =
    `${count("created")} created, ${count("updated")} updated, ` +
    `${count("unchanged")} unchanged, ${count("failed")} failed`;
console.log(`Done: ${summaryLine}.`);
 
if (CONFIG.notifyWhenDone) warp.notify.say("Customer project reports", summaryLine);
 
// Copy these into CONFIG.existingFiles so the next run validates against them
const existingFilesForNextRun = Object.fromEntries(
    results.filter(r => r.path).map(r => [r.customer, r.path]));
 
return { results, existingFilesForNextRun };