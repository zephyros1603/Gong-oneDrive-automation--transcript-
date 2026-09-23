// This runs inside the Warp script engine (core/engine/sandbox.js) — there is
// no require(), no fs, no ExcelJS import. `warp` is the only thing in scope;
// see docs/engine-api.md for the full warp.* reference.

// ============================================================
// 1. CONFIGURATION
// ============================================================

const OUTPUT_NAME = "Paycor-Entra-ID-Project-Report";

const PROJECT_ID = "proj_1776140543070_4f5e550b";
const PROJECT_DISPLAY_ID = "PS-0238";


// ============================================================
// 2. GET YOUR API JSON HERE
// ============================================================
//
// warp.cxp.projectDetail() is the combined call — task hours, both audit
// logs (project-wide and station-scoped), tasks, docs, folders, notes,
// connector images, and (with displayId) linked Jira, all in one round trip.
// Its keys are exactly what the rest of this script already expects:
// projectData.audit.logs, projectData.stationAudit.logs,
// projectData.tasks.tasks. See docs/cxportal-api.md's project-detail section
// for the full shape.
// ------------------------------------------------------------

const projectData = await warp.cxp.projectDetail(PROJECT_ID, {
    displayId: PROJECT_DISPLAY_ID,
});


// ============================================================
// 3. HELPERS
// ============================================================

function safe(value) {
    return value === undefined || value === null ? "" : value;
}

function parseDate(value) {
    if (!value) return null;

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date;
}

function formatDate(value) {
    const date = parseDate(value);

    if (!date) return "";

    return date;
}

function formatDateText(value) {
    const date = parseDate(value);

    if (!date) return "";

    return date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
}

function normalizeString(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase();
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}


// ============================================================
// 4. GET PROJECT AUDIT LOGS
// ============================================================

function getProjectAuditLogs(projectData) {

    return (projectData?.audit?.logs || [])
        .filter(log =>
            log.entityType === "project" &&
            log.projectId === PROJECT_ID
        )
        .sort((a, b) =>
            new Date(a.timestamp) - new Date(b.timestamp)
        );
}


// ============================================================
// 5. GET LATEST PROJECT AUDIT
// ============================================================

function getLatestProjectAudit(projectData) {

    const logs = getProjectAuditLogs(projectData);

    return logs.length
        ? logs[logs.length - 1]
        : null;
}


// ============================================================
// 6. EXTRACT TARGET DATE CHANGES
// ============================================================
//
// IMPORTANT:
//
// We only care about audit changes related to:
//
//   targetDate
//   endDate
//   targetDateChangeReason
//   targetDateChangeDate
//   targetDateHistory
//
// We do NOT scrape unrelated audit activity such as:
//   consultant changes
//   station changes
//   custom fields
//   task creation
//   notes
//
// This keeps the workbook aligned with the existing Change Log.
// ============================================================

function extractTargetDateChanges(projectData) {

    const logs = getProjectAuditLogs(projectData);

    const changes = [];

    for (const log of logs) {

        const targetDateChange = (log.changes || [])
            .find(change =>
                change.field === "targetDate"
            );

        const historyChange = (log.changes || [])
            .find(change =>
                change.field === "targetDateHistory"
            );

        // ----------------------------------------------------
        // Preferred source:
        //
        // targetDateHistory
        // ----------------------------------------------------

        if (historyChange?.newValue) {

            const history = parseTargetDateHistory(
                historyChange.newValue
            );

            for (const item of history) {

                if (
                    item.oldDate &&
                    item.newDate &&
                    item.oldDate !== item.newDate
                ) {

                    changes.push({
                        oldDate: item.oldDate,
                        newDate: item.newDate,
                        reason: item.reason || "",
                        owner: item.owner || "",
                        changedBy: item.changedBy || "",
                        changedByEmail: item.changedByEmail || "",
                        changedAt: item.changedAt || log.timestamp,
                        sourceLogId: log.logId
                    });
                }
            }
        }

        // ----------------------------------------------------
        // Fallback:
        //
        // Direct targetDate audit change
        // ----------------------------------------------------

        if (
            targetDateChange &&
            targetDateChange.oldValue &&
            targetDateChange.newValue &&
            targetDateChange.oldValue !== targetDateChange.newValue
        ) {

            const alreadyExists = changes.some(change =>
                change.oldDate === targetDateChange.oldValue &&
                change.newDate === targetDateChange.newValue
            );

            if (!alreadyExists) {

                const reasonChange = (log.changes || [])
                    .find(change =>
                        change.field === "targetDateChangeReason"
                    );

                const dateChange = (log.changes || [])
                    .find(change =>
                        change.field === "targetDateChangeDate"
                    );

                changes.push({
                    oldDate: targetDateChange.oldValue,
                    newDate: targetDateChange.newValue,
                    reason: safe(reasonChange?.newValue),
                    owner: "",
                    changedBy: log.userName || "",
                    changedByEmail: log.userId || "",
                    changedAt:
                        dateChange?.newValue ||
                        log.timestamp,
                    sourceLogId: log.logId
                });
            }
        }
    }

    // --------------------------------------------------------
    // Deduplicate
    // --------------------------------------------------------

    const unique = new Map();

    for (const change of changes) {

        const key = [
            change.oldDate,
            change.newDate,
            change.changedAt,
            change.reason
        ].join("|");

        unique.set(key, change);
    }

    return [...unique.values()]
        .sort((a, b) =>
            new Date(a.changedAt) - new Date(b.changedAt)
        );
}


// ============================================================
// 7. PARSE targetDateHistory
// ============================================================
//
// The API currently returns this field as a string that can
// contain multiple Python-style dictionaries:
//
// "{'owner': 'customer', ...}, {'owner': 'customer', ...}"
//
// So we normalize it before parsing.
// ============================================================

function parseTargetDateHistory(value) {

    if (!value) return [];

    if (Array.isArray(value)) {
        return value;
    }

    if (typeof value === "object") {
        return [value];
    }

    let text = String(value).trim();

    if (!text) return [];

    // Try normal JSON first.
    try {
        const parsed = JSON.parse(text);

        return Array.isArray(parsed)
            ? parsed
            : [parsed];

    } catch (_) {
        // Continue with Python-style dictionary parsing.
    }

    // --------------------------------------------------------
    // Convert:
    //
    // {'owner': 'customer', 'reason': 'Work in progress'}
    //
    // into JSON-ish strings.
    // --------------------------------------------------------

    text = text
        .replace(/\\'/g, "__ESCAPED_SINGLE_QUOTE__")
        .replace(/'/g, '"')
        .replace(
            /__ESCAPED_SINGLE_QUOTE__/g,
            "\\'"
        );

    // Split multiple dictionary objects.
    const objects = [];

    let depth = 0;
    let start = -1;

    for (let i = 0; i < text.length; i++) {

        const char = text[i];

        if (char === "{") {

            if (depth === 0) {
                start = i;
            }

            depth++;

        } else if (char === "}") {

            depth--;

            if (depth === 0 && start !== -1) {

                objects.push(
                    text.substring(start, i + 1)
                );

                start = -1;
            }
        }
    }

    const result = [];

    for (const objectText of objects) {

        try {

            const parsed = JSON.parse(objectText);

            result.push(parsed);

        } catch (error) {

            // ------------------------------------------------
            // Last-resort extraction.
            // We only extract fields needed by the workbook.
            // ------------------------------------------------

            const extract = key => {

                const regex = new RegExp(
                    `"${key}"\\s*:\\s*"([^"]*)"`
                );

                const match = objectText.match(regex);

                return match ? match[1] : "";
            };

            result.push({
                id: extract("id"),
                changedBy: extract("changedBy"),
                changedByEmail: extract("changedByEmail"),
                changedAt: extract("changedAt"),
                oldDate: extract("oldDate"),
                newDate: extract("newDate"),
                reason: extract("reason"),
                owner: extract("owner")
            });
        }
    }

    return result;
}


// ============================================================
// 8. GET CURRENT GO-LIVE DATE
// ============================================================

function getCurrentGoLiveDate(projectData) {

    const changes = extractTargetDateChanges(projectData);

    if (!changes.length) {
        return "";
    }

    return changes[changes.length - 1].newDate;
}


// ============================================================
// 9. GET CURRENT SLIPPAGE REASON
// ============================================================

function getCurrentSlippageReason(projectData) {

    const changes = extractTargetDateChanges(projectData);

    if (!changes.length) {
        return "";
    }

    const latest = changes[changes.length - 1];

    let reason = "";

    if (latest.owner) {
        reason += `Owner: ${
            capitalize(latest.owner)
        }. `;
    }

    reason += latest.reason || "";

    return reason.trim();
}


function capitalize(value) {

    if (!value) return "";

    return value.charAt(0).toUpperCase() +
        value.slice(1);
}


// ============================================================
// 10. GET CURRENT PROJECT STATUS
// ============================================================

function getProjectStatus(projectData) {

    const stationLogs =
        projectData?.stationAudit?.logs || [];

    if (!stationLogs.length) {
        return "Unknown";
    }

    const sorted = [...stationLogs]
        .sort((a, b) =>
            new Date(a.timestamp) -
            new Date(b.timestamp)
        );

    const latest = sorted[sorted.length - 1];

    const status =
        latest?.changes?.find(
            change => change.field === "status"
        )?.newValue;

    switch (normalizeString(status)) {

        case "in_progress":
            return "In Implementation";

        case "queued":
            return "Queued";

        case "complete":
        case "completed":
            return "Complete";

        case "blocked":
            return "Blocked";

        default:
            return status || "Unknown";
    }
}


// ============================================================
// 11. GET PROJECT TASKS
// ============================================================

function getProjectTasks(projectData) {

    return (projectData?.tasks?.tasks || [])
        .filter(task =>
            task.projectId === PROJECT_ID
        );
}


// ============================================================
// 12. FIND TASK BY NAME
// ============================================================

function findTask(tasks, name) {

    const target = normalizeString(name);

    return tasks.find(task => {

        const taskName =
            normalizeString(task.name);

        return (
            taskName === target ||
            taskName.includes(target) ||
            target.includes(taskName)
        );
    });
}


// ============================================================
// 13. CREATE WORKBOOK
// ============================================================

async function createWorkbook(projectData) {

    const workbook = new warp.excel.Workbook();

    workbook.creator = "Project Report Generator";
    workbook.created = new Date();
    workbook.modified = new Date();


    // ========================================================
    // SUMMARY
    // ========================================================

    const summary = workbook.addWorksheet("Summary");

    summary.mergeCells("B1:I1");
    summary.mergeCells("B2:I2");
    summary.mergeCells("B13:I18");

    summary.getCell("B1").value =
        "RW Supply and Design LLC -- Program Executive Summary";

    summary.getCell("B2").value =
        "SDM: Makarand Kulkarni | EM: Sanjan | PCO: Mansi Milind Khadke | CAM: Benjamin Stephens | Sales handoff Date: 31-Jan-2026";


    summary.getCell("B4").value = "Project Status";
    summary.getCell("G4").value = "Blocker Table";

    summary.getRow(5).values = [
        null,
        "Projects",
        "Status",
        "Target Go-Live",
        null,
        null,
        "Blocked On",
        "Date of Blocker",
        "JIRA"
    ];

    const latestProjectAudit =
        getLatestProjectAudit(projectData);

    const currentGoLive =
        getCurrentGoLiveDate(projectData);

    const currentStatus =
        getProjectStatus(projectData);

    summary.getRow(6).values = [
        null,
        latestProjectAudit?.projectName ||
            "Paycor/Entra ID",

        currentStatus,

        formatDate(currentGoLive),

        null,
        null,

        // Workbook currently represents this as Customer.
        // Keep this tied to the latest target-date history.
        extractTargetDateChanges(projectData)
            .at(-1)?.owner === "customer"
            ? "Customer"
            : "",

        null,

        "NA"
    ];


    // ========================================================
    // CHANGE LOG
    // ========================================================

    summary.getCell("B8").value =
        "Change Log for Go Live";

    summary.getRow(9).values = [
        null,
        "Project",
        "Estimated Go Live",
        "Updated Go Live",
        "Reason for Slippage"
    ];

    const dateChanges =
        extractTargetDateChanges(projectData);

    const latestChange =
        dateChanges.length
            ? dateChanges[dateChanges.length - 1]
            : null;

    summary.getRow(10).values = [
        null,
        latestProjectAudit?.projectName ||
            "Paycor/Entra ID",

        // The first historical date becomes the
        // original/estimated go-live.
        dateChanges.length
            ? formatDate(dateChanges[0].oldDate)
            : "",

        latestChange
            ? formatDate(latestChange.newDate)
            : "",

        getCurrentSlippageReason(projectData)
    ];


    // ========================================================
    // EXECUTIVE SUMMARY
    // ========================================================

    summary.getCell("B13").value =
        buildExecutiveSummary(projectData);

    // ========================================================
    // SUMMARY FORMATTING
    // ========================================================

    summary.columnWidths = {
        B: 30,
        C: 16,
        D: 15,
        E: 58,
        G: 15,
        H: 18,
        I: 15
    };

    summary.getCell("B13").alignment = {
        wrapText: true,
        vertical: "top"
    };


    // ========================================================
    // SCOPING
    // ========================================================
    //
    // IMPORTANT:
    //
    // The supplied API JSON does NOT contain enough structured
    // information to reconstruct this sheet reliably.
    //
    // Therefore this remains the project template.
    //
    // Do not invent lifecycle scope from audit notes.
    // ========================================================

    createScopingSheet(workbook);


    // ========================================================
    // PROJECT PLAN
    // ========================================================

    createProjectPlan(
        workbook,
        projectData
    );


    // ========================================================
    // ACTION ITEMS
    // ========================================================
    //
    // There is no dedicated structured actionItems collection
    // in the supplied JSON.
    //
    // Therefore do not manufacture action items from notes.
    // ========================================================

    createActionItemsSheet(workbook);


    // ========================================================
    // LISTS
    // ========================================================

    createListsSheet(workbook);


    // ========================================================
    // SAVE
    // ========================================================
    //
    // warp.excel.save() writes into Warp's documents library and returns
    // where it landed — never workbook.xlsx.writeFile() with a path of our
    // own choosing, which would be a real, unsandboxed disk write (see
    // docs/engine-api.md's warp.excel section for why).

    const saved = await warp.excel.save(workbook, OUTPUT_NAME);

    console.log(`Workbook created: ${saved.path}`);

    return {
        saved,
        projectName:
            latestProjectAudit?.projectName ||
            "Paycor/Entra ID",
    };
}


// ============================================================
// 14. EXECUTIVE SUMMARY
// ============================================================

function buildExecutiveSummary(projectData) {

    const dateChanges =
        extractTargetDateChanges(projectData);

    const latest =
        dateChanges.at(-1);

    if (!latest) {
        return "No go-live date change information was found.";
    }

    const date =
        formatDateText(latest.newDate);

    const owner =
        latest.owner
            ? ` The delay is owned by ${latest.owner}.`
            : "";

    return (
        `Target go-live is now ${date}, ` +
        `pushed by ${latest.reason || "the latest project delay"}.` +
        owner
    );
}


// ============================================================
// 15. PROJECT PLAN SHEET
// ============================================================

function createProjectPlan(workbook, projectData) {

    const ws =
        workbook.addWorksheet(
            "Project Plan - Paycor Entra ID"
        );

    ws.mergeCells("A1:K1");
    ws.mergeCells("A2:K2");
    ws.mergeCells("A29:K30");
    ws.mergeCells("A32:K33");

    ws.getCell("A1").value =
        "RW Supply -- Milestone Tracker";

    ws.getCell("A2").value =
        "Use Case: Paycor -> AD /Entra   |   PS Tracker ID: PS-0238";

    ws.getRow(4).values = [
        "Milestone",
        "Milestone Name",
        "Task",
        "Status",
        "Owner",
        "Current Status",
        "Dependencies / Description",
        "Start Date",
        "Finish Date",
        "Days Taken",
        "Go Live Date"
    ];

    const tasks =
        getProjectTasks(projectData);


    // --------------------------------------------------------
    // These are the workbook's milestone/task definitions.
    //
    // The API tasks are matched against these names.
    // --------------------------------------------------------

    const milestoneRows = [

        ["M1", "Kickoff & Discovery",
            "Sales handoff, onboarding concierge, and kickoff calls"],

        ["M2", "Connectivity",
            "Connectivity Validation"],

        ["M3", "Integration Analysis",
            "Discovery & Solution Walkthrough"],

        ["M4", "Implementation & Configuration",
            "Configuration & Attribute Mapping"],

        ["", "",
            "Group Rule Configuration"],

        ["", "",
            "OU Mapping Configuration"],

        ["", "",
            "Writeback configuration"],

        ["", "",
            "Reporting Configuration"],

        ["M5", "Testing & UAT",
            "Execution with Test record"],

        ["", "",
            "Validation & Report-Only Testing"],

        ["", "",
            "Customer UAT"],

        ["", "",
            "Controlled Execution of Live Records"],

        ["M6", "Go-Live",
            "Go-Live Cutover & Sign-off"],

        ["", "",
            "Hypercare"],

        ["M7", "Handover to Support",
            "Documentation"],

        ["", "",
            "Training"]
    ];


    let rowNumber = 5;

    for (const [
        milestone,
        milestoneName,
        taskName
    ] of milestoneRows) {

        const task =
            findTask(tasks, taskName);

        let status = "Not Started";
        let owner = "";
        let currentStatus = "";
        let startDate = "";
        let finishDate = "";
        let daysTaken = "";

        if (task) {

            status =
                mapTaskStatus(task.status);

            owner =
                task.consultantName ||
                task.assigneeName ||
                "";

            currentStatus =
                task.description ||
                "";

            startDate =
                parseDate(task.createdAt);

            if (
                normalizeString(task.status) ===
                "closed"
            ) {
                finishDate =
                    parseDate(task.updatedAt);
            }

            if (startDate && finishDate) {

                daysTaken =
                    Math.max(
                        0,
                        Math.ceil(
                            (
                                finishDate -
                                startDate
                            ) /
                            (1000 * 60 * 60 * 24)
                        )
                    );
            }
        }

        ws.getRow(rowNumber).values = [
            milestone,
            milestoneName,
            taskName,
            status,
            owner,
            currentStatus,
            "",
            startDate,
            finishDate,
            daysTaken,
            formatDate(
                getCurrentGoLiveDate(projectData)
            )
        ];

        rowNumber++;
    }

    ws.getCell("A32").value =
        'Note: Start Date = previous milestone\'s Finish Date. ' +
        'Days Taken = Finish Date minus Start Date.';

    ws.columnWidths = {
        A: 11,
        B: 27,
        C: 34,
        D: 13,
        E: 22,
        F: 30,
        G: 40,
        H: 19,
        I: 16,
        J: 12,
        K: 15
    };
}


// ============================================================
// 16. MAP TASK STATUS
// ============================================================

function mapTaskStatus(status) {

    switch (normalizeString(status)) {

        case "closed":
        case "complete":
        case "completed":
            return "Complete";

        case "open":
        case "in progress":
            return "In Progress";

        case "blocked":
            return "Blocked";

        default:
            return status || "Not Started";
    }
}


// ============================================================
// 17. SCOPING
// ============================================================

function createScopingSheet(workbook) {

    const ws =
        workbook.addWorksheet("Scoping");

    ws.mergeCells("B1:J1");
    ws.mergeCells("B2:J2");

    ws.getCell("B1").value =
        "Scoping Document";

    ws.getCell("B2").value =
        "Lifecycle Events in Scope, by Use Case";

    ws.getCell("B4").value =
        "In Scope";

    ws.getRow(5).values = [
        null,
        "Project",
        "#",
        "Use case",
        "Custom Scripts (Y/N)",
        "Status"
    ];

    // --------------------------------------------------------
    // These values are retained from the workbook because the
    // supplied API JSON does not expose structured scope data.
    // --------------------------------------------------------

    const scopeRows = [
        ["Paycor/AD", 1, "Creation", "N", "configured"],
        ["Paycor/AD", 2, "updation", "N", "live"],
        ["Paycor/AD", 3, "deactivatio", "N", "live"],
        ["Paycor/Entra", 3, "License", "N", "live"]
    ];

    let row = 6;

    for (const item of scopeRows) {

        ws.getRow(row).values = [
            null,
            ...item
        ];

        row++;
    }

    ws.getCell("B13").value =
        "Out Of Scope: Change Log";

    ws.getRow(14).values = [
        null,
        "Project",
        "CR ID",
        "Use case",
        "Description",
        "Date Added",
        "Extra Hours Needed",
        "Status"
    ];

    ws.getRow(15).values = [
        null,
        "Paycor/Entra ID"
    ];

    ws.columnWidths = {
        B: 16,
        C: 6,
        D: 13,
        E: 21,
        F: 12,
        G: 19,
        H: 13,
        I: 17,
        J: 46
    };
}


// ============================================================
// 18. ACTION ITEMS
// ============================================================

function createActionItemsSheet(workbook) {

    const ws =
        workbook.addWorksheet(
            "Action Items tracker"
        );

    ws.mergeCells("A1:I1");
    ws.mergeCells("A2:I2");

    ws.getCell("A1").value =
        "Action Item Tracker";

    ws.getCell("A2").value =
        "After every customer call: pick your project from the Use Case dropdown, log the action item and owner, set Status, and set the Due Date.";

    ws.getRow(4).values = [
        "#",
        "Use Case",
        "Action Item",
        "Owner",
        "Status",
        "Date Raised",
        "Target Date",
        "Date Closed",
        "Note"
    ];

    // --------------------------------------------------------
    // Do NOT create fake action items from notes.
    //
    // If your await response later contains:
    //
    // projectData.actionItems
    //
    // this is where we should populate them.
    // --------------------------------------------------------

    const actionItems =
        projectDataActionItemsPlaceholder();

    let row = 5;

    for (const item of actionItems) {

        ws.getRow(row).values = [
            item.number,
            item.useCase,
            item.actionItem,
            item.owner,
            item.status,
            formatDate(item.dateRaised),
            formatDate(item.targetDate),
            formatDate(item.dateClosed),
            item.note
        ];

        row++;
    }

    ws.columnWidths = {
        A: 6,
        B: 37,
        C: 46,
        D: 22,
        E: 13,
        I: 60
    };
}


function projectDataActionItemsPlaceholder() {

    // IMPORTANT:
    //
    // Return [] until the API exposes a structured
    // action-item collection.
    //
    // Do not infer action items from notes.

    return [];
}


// ============================================================
// 19. LISTS
// ============================================================

function createListsSheet(workbook) {

    const ws =
        workbook.addWorksheet("Lists");

    const values = [
        [
            "Paycor/Entra ID",
            "Live",
            "Complete",
            "Open",
            "Risk",
            "Critical",
            "Open",
            "Yes",
            "Y"
        ],
        [
            "All Use Cases",
            "In Implementation",
            "In Progress",
            "In Progress",
            "Assumption",
            "High",
            "Monitoring",
            "No",
            "N"
        ],
        [
            null,
            "In Progress",
            "Not Started",
            "Complete",
            "Issue",
            "Medium",
            "Closed - Resolved",
            "TBD",
            null
        ],
        [
            null,
            "UAT",
            "Blocked",
            "Blocked",
            "Dependency",
            "Low",
            null,
            "NA",
            null
        ],
        [
            null,
            "Not Yet Started",
            null,
            null,
            null,
            null,
            null,
            null,
            null
        ]
    ];

    for (const row of values) {
        ws.addRow(row);
    }
}


// ============================================================
// 20. RUN
// ============================================================
//
// A `return` here is what the script engine's run log reports as the
// result. Building the workbook and proposing it for review are the two
// halves — nothing gets delivered anywhere until a person approves it from
// the Approvals page.
// ============================================================

const { saved, projectName } = await createWorkbook(projectData);

return warp.approvals.propose({
    title: `${projectName} — Project Report (${PROJECT_DISPLAY_ID})`,
    path: saved.path,
});