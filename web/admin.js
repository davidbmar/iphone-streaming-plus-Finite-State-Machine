"use strict";

// ═══════════════════════════════════════════════════════════════
//  Admin Dashboard — Voice Agent WebRTC Admin Panel
//  Vanilla JS single-page app, no frameworks
// ═══════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// Utility: XSS-safe text escaping
// All user-generated content MUST pass through esc() before insertion.
// ---------------------------------------------------------------------------

function esc(str) {
    if (str == null) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTime(iso) {
    if (!iso) return "--";
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
            ", " +
            d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    } catch (_) {
        return iso;
    }
}

function formatDuration(startIso, endIso) {
    if (!startIso || !endIso) return "--";
    try {
        const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
        if (isNaN(ms) || ms < 0) return "--";
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) return h + "h " + m + "m " + s + "s";
        if (m > 0) return m + "m " + s + "s";
        return s + "s";
    } catch (_) {
        return "--";
    }
}

function formatBytes(n) {
    if (n == null || isNaN(n)) return "--";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatUptime(seconds) {
    if (seconds == null || isNaN(seconds)) return "--";
    seconds = Math.floor(seconds);
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + "d " + h + "h " + m + "m";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
}

// ---------------------------------------------------------------------------
// Auth state — supports admin token OR user session token (from Google login)
// ---------------------------------------------------------------------------

let adminToken = sessionStorage.getItem("admin_token") || "";
let sessionToken = localStorage.getItem("session_token") || "";
let currentRole = ""; // "admin" or "user"
let currentUser = null; // {id, name, email, avatar_url} when role=user

function getAdminToken() {
    return adminToken;
}

function setAdminToken(t) {
    adminToken = t;
    sessionStorage.setItem("admin_token", t);
}

function getSessionToken() {
    return sessionToken;
}

// ---------------------------------------------------------------------------
// API fetch helper — sends admin token as ?token= OR session token as header
// ---------------------------------------------------------------------------

async function apiFetch(path, options) {
    options = options || {};
    options.headers = options.headers || {};

    var url = path;
    if (adminToken) {
        // Admin token auth via query param
        var sep = path.includes("?") ? "&" : "?";
        url = path + sep + "token=" + encodeURIComponent(adminToken);
    } else if (sessionToken) {
        // User session token via header
        options.headers["X-Session-Token"] = sessionToken;
    }

    var resp = await fetch(url, options);
    if (resp.status === 401) {
        // Token invalid — clear and show auth gate
        setAdminToken("");
        sessionToken = "";
        showAuthGate();
        throw new Error("Unauthorized");
    }
    if (!resp.ok) {
        var text = await resp.text();
        throw new Error("API " + resp.status + ": " + text);
    }
    var ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
        return resp.json();
    }
    return resp.text();
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const authGate = document.getElementById("auth-gate");
const authTokenInput = document.getElementById("admin-token");
const authBtn = document.getElementById("auth-btn");
const authStatus = document.getElementById("auth-status");
const dashboard = document.getElementById("dashboard");

// Tab buttons and panels
const tabBtns = document.querySelectorAll(".tab-btn");
const tabConversations = document.getElementById("tab-conversations");
const tabLogs = document.getElementById("tab-logs");
const tabTools = document.getElementById("tab-tools");
const tabConfig = document.getElementById("tab-config");

// Conversations
const sessionSearch = document.getElementById("session-search");
const refreshSessionsBtn = document.getElementById("refresh-sessions-btn");
const clearAllBtn = document.getElementById("clear-all-btn");
const sessionsList = document.getElementById("sessions-list");
const sessionDetail = document.getElementById("session-detail");
const sessionDetailContent = document.getElementById("session-detail-content");
const backToListBtn = document.getElementById("back-to-list-btn");

// Logs
const logOutput = document.getElementById("log-output");
const pauseLogsBtn = document.getElementById("pause-logs-btn");
const logSearch = document.getElementById("log-search");
const levelBtns = document.querySelectorAll(".level-btn");

// Tools & RAG
const toolsList = document.getElementById("tools-list");
const searchProviders = document.getElementById("search-providers");
const ragList = document.getElementById("rag-list");
const addRagBtn = document.getElementById("add-rag-btn");
const ragForm = document.getElementById("rag-form");
const saveRagBtn = document.getElementById("save-rag-btn");
const cancelRagBtn = document.getElementById("cancel-rag-btn");

// Config
const serverInfo = document.getElementById("server-info");
const llmConfig = document.getElementById("llm-config");
const searchQuota = document.getElementById("search-quota");
const serverUptime = document.getElementById("server-uptime");
const downloadLogLink = document.getElementById("download-log-link");

// ---------------------------------------------------------------------------
// Safe HTML builder — escapes all dynamic values via esc(), renders via
// textContent where possible, and uses innerHTML only for structural markup
// with pre-escaped content.
// ---------------------------------------------------------------------------

// Helper to set an element's content from pre-escaped HTML strings.
// All dynamic values inserted into these strings MUST go through esc() first.
function setSafeHTML(el, escapedHTML) {
    if (!el) return;
    el.innerHTML = escapedHTML; // eslint-disable-line -- all values pre-escaped via esc()
}

// ---------------------------------------------------------------------------
// 1. Auth
// ---------------------------------------------------------------------------

function showAuthGate() {
    authGate.style.display = "";
    dashboard.classList.add("hidden");
}

function hideAuthGate() {
    authGate.style.display = "none";
    dashboard.classList.remove("hidden");
}

function updateUserDisplay() {
    var uptimeEl = document.getElementById("server-uptime");
    var headerBar = document.getElementById("header-bar");
    // Show user badge in header if logged in as user
    var existing = document.getElementById("user-badge");
    if (existing) existing.remove();

    if (currentRole === "user" && currentUser) {
        var badge = document.createElement("span");
        badge.id = "user-badge";
        badge.className = "user-badge";
        if (currentUser.avatar_url) {
            var img = document.createElement("img");
            img.src = currentUser.avatar_url;
            img.alt = "";
            img.className = "user-avatar";
            badge.appendChild(img);
        }
        badge.appendChild(document.createTextNode(currentUser.name || currentUser.email));
        if (headerBar) headerBar.appendChild(badge);
    } else if (currentRole === "admin") {
        var adminBadge = document.createElement("span");
        adminBadge.id = "user-badge";
        adminBadge.className = "user-badge admin-badge";
        adminBadge.textContent = "ADMIN";
        if (headerBar) headerBar.appendChild(adminBadge);
    }
}

async function fetchIdentity() {
    var me = await apiFetch("/api/admin/me");
    currentRole = me.role;
    currentUser = me.user;
    updateUserDisplay();
}

async function authenticate() {
    var inputToken = authTokenInput.value.trim();
    if (!inputToken) {
        authStatus.textContent = "Please enter a token.";
        return;
    }
    setAdminToken(inputToken);
    authStatus.textContent = "Authenticating...";
    try {
        await fetchIdentity();
        authStatus.textContent = "";
        hideAuthGate();
        onDashboardReady();
    } catch (e) {
        authStatus.textContent = "Authentication failed.";
        setAdminToken("");
    }
}

// On page load: try session token (Google login) first, then admin token
(function initAuth() {
    // 1. Try URL query param token (admin bookmark)
    var urlParams = new URLSearchParams(window.location.search);
    var urlToken = urlParams.get("token");
    if (urlToken) {
        setAdminToken(urlToken);
    }

    // 2. Try admin token
    if (adminToken) {
        authStatus.textContent = "Checking admin token...";
        fetchIdentity()
            .then(function () {
                authStatus.textContent = "";
                hideAuthGate();
                onDashboardReady();
            })
            .catch(function () {
                authStatus.textContent = "";
                setAdminToken("");
                // Fall through to try session token
                trySessionToken();
            });
        return;
    }

    // 3. Try user session token from Google login
    trySessionToken();

    function trySessionToken() {
        sessionToken = localStorage.getItem("session_token") || "";
        if (sessionToken) {
            authStatus.textContent = "Signing in with Google account...";
            fetchIdentity()
                .then(function () {
                    authStatus.textContent = "";
                    hideAuthGate();
                    onDashboardReady();
                })
                .catch(function () {
                    authStatus.textContent = "";
                    sessionToken = "";
                    showAuthGate();
                });
        } else {
            showAuthGate();
        }
    }
})();

authBtn.addEventListener("click", authenticate);
authTokenInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") authenticate();
});

// ---------------------------------------------------------------------------
// 2. Tab switching
// ---------------------------------------------------------------------------

const tabPanels = {
    conversations: tabConversations,
    logs: tabLogs,
    tools: tabTools,
    config: tabConfig,
};

const tabRefresh = {
    conversations: function () { loadSessions(); },
    logs: function () { connectLogWS(); },
    tools: function () { loadTools(); loadSearchProviders(); loadRagEndpoints(); },
    config: function () { loadConfig(); },
};

let activeTab = "conversations";

function switchTab(tabName) {
    if (!tabPanels[tabName]) return;
    activeTab = tabName;

    // Update tab buttons
    tabBtns.forEach(function (btn) {
        if (btn.dataset.tab === tabName) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });

    // Update panels
    Object.keys(tabPanels).forEach(function (key) {
        if (key === tabName) {
            tabPanels[key].classList.remove("hidden");
        } else {
            tabPanels[key].classList.add("hidden");
        }
    });

    // Disconnect log WS when leaving logs tab to save resources
    if (tabName !== "logs") {
        disconnectLogWS();
    }

    // Refresh data for the active tab
    if (tabRefresh[tabName]) {
        tabRefresh[tabName]();
    }
}

tabBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
        switchTab(btn.dataset.tab);
    });
});

// ---------------------------------------------------------------------------
// Dashboard ready — load initial data
// ---------------------------------------------------------------------------

function onDashboardReady() {
    switchTab("conversations");
    // Update download-log link with auth
    if (downloadLogLink) {
        var logAuth = adminToken
            ? "token=" + encodeURIComponent(adminToken)
            : "session_token=" + encodeURIComponent(sessionToken);
        downloadLogLink.href = "/api/admin/logs?limit=99999&" + logAuth;
    }
}

// ---------------------------------------------------------------------------
// 3. Conversations tab
// ---------------------------------------------------------------------------

let searchDebounceTimer = null;

async function loadSessions() {
    const search = (sessionSearch && sessionSearch.value.trim()) || "";
    try {
        const sessions = await apiFetch(
            "/api/admin/sessions?limit=50&offset=0" +
            (search ? "&search=" + encodeURIComponent(search) : "")
        );
        renderSessions(sessions);
    } catch (e) {
        console.log("loadSessions error:", e);
        sessionsList.textContent = "";
        var errP = document.createElement("p");
        errP.className = "error-msg";
        errP.textContent = "Failed to load sessions.";
        sessionsList.appendChild(errP);
    }
}

function renderSessions(sessions) {
    // Show session list, hide detail
    sessionsList.classList.remove("hidden");
    sessionDetail.classList.add("hidden");

    // Clear existing content
    sessionsList.textContent = "";

    if (!sessions || sessions.length === 0) {
        var emptyP = document.createElement("p");
        emptyP.className = "empty-msg";
        emptyP.textContent = "No sessions found.";
        sessionsList.appendChild(emptyP);
        return;
    }

    var table = document.createElement("table");
    table.className = "sessions-table";

    // Build thead
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["Started", "Duration", "Turns", "Model"].forEach(function (label) {
        var th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    // Build tbody
    var tbody = document.createElement("tbody");
    sessions.forEach(function (s) {
        var tr = document.createElement("tr");
        tr.className = "session-row";
        tr.dataset.id = s.id;

        var tdStarted = document.createElement("td");
        tdStarted.textContent = formatTime(s.started_at);
        tr.appendChild(tdStarted);

        var tdDuration = document.createElement("td");
        tdDuration.textContent = formatDuration(s.started_at, s.ended_at);
        tr.appendChild(tdDuration);

        var tdTurns = document.createElement("td");
        tdTurns.textContent = s.turn_count != null ? s.turn_count : "--";
        tr.appendChild(tdTurns);

        var tdModel = document.createElement("td");
        tdModel.textContent = s.llm_model || s.llm_provider || "--";
        tr.appendChild(tdModel);

        tr.addEventListener("click", function () {
            loadSessionDetail(s.id);
        });

        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    sessionsList.appendChild(table);
}

async function loadSessionDetail(id) {
    try {
        const data = await apiFetch("/api/admin/sessions/" + encodeURIComponent(id));
        renderSessionDetail(data);
    } catch (e) {
        console.log("loadSessionDetail error:", e);
        sessionDetailContent.textContent = "";
        var errP = document.createElement("p");
        errP.className = "error-msg";
        errP.textContent = "Failed to load session detail.";
        sessionDetailContent.appendChild(errP);
    }
}

function renderSessionDetail(data) {
    // Hide list, show detail
    sessionsList.classList.add("hidden");
    sessionDetail.classList.remove("hidden");

    var session = data.session || {};
    var turns = data.turns || [];

    // Clear previous content
    sessionDetailContent.textContent = "";

    // Session header
    var headerDiv = document.createElement("div");
    headerDiv.className = "session-header";

    var h3 = document.createElement("h3");
    h3.textContent = "Session " + (session.id || "");
    headerDiv.appendChild(h3);

    var metaDiv = document.createElement("div");
    metaDiv.className = "session-meta";

    var metaItems = [
        { label: "Started", value: formatTime(session.started_at) },
        { label: "Ended", value: formatTime(session.ended_at) },
        { label: "Duration", value: formatDuration(session.started_at, session.ended_at) },
        { label: "IP", value: session.client_ip || "--" },
        { label: "Timezone", value: session.timezone || "--" },
        { label: "Model", value: (session.llm_provider || "") + "/" + (session.llm_model || "") },
        { label: "Voice", value: session.voice || "--" },
    ];
    metaItems.forEach(function (item) {
        var span = document.createElement("span");
        var strong = document.createElement("strong");
        strong.textContent = item.label + ": ";
        span.appendChild(strong);
        span.appendChild(document.createTextNode(item.value));
        metaDiv.appendChild(span);
    });
    headerDiv.appendChild(metaDiv);
    sessionDetailContent.appendChild(headerDiv);

    // Turns
    if (turns.length === 0) {
        var emptyP = document.createElement("p");
        emptyP.className = "empty-msg";
        emptyP.textContent = "No turns in this session.";
        sessionDetailContent.appendChild(emptyP);
        return;
    }

    var turnsList = document.createElement("div");
    turnsList.className = "turns-list";

    turns.forEach(function (turn) {
        var isUser = turn.role === "user";
        var card = document.createElement("div");
        card.className = "turn-card turn-" + (turn.role || "unknown");

        // Turn header
        var turnHeader = document.createElement("div");
        turnHeader.className = "turn-header";

        var roleSpan = document.createElement("span");
        roleSpan.className = "turn-role";
        roleSpan.textContent = isUser ? "User" : "Agent";
        turnHeader.appendChild(roleSpan);

        var timeSpan = document.createElement("span");
        timeSpan.className = "turn-time";
        timeSpan.textContent = formatTime(turn.timestamp);
        turnHeader.appendChild(timeSpan);

        card.appendChild(turnHeader);

        // Full text (no truncation -- this is the key feature)
        var textDiv = document.createElement("div");
        textDiv.className = "turn-text";
        textDiv.textContent = turn.text || "";
        card.appendChild(textDiv);

        if (isUser) {
            // Audio stats for user turns
            var stats = [];
            if (turn.audio_duration_s != null) {
                stats.push("Duration: " + Number(turn.audio_duration_s).toFixed(1) + "s");
            }
            if (turn.rms != null) {
                stats.push("RMS: " + Number(turn.rms).toFixed(4));
            }
            if (turn.peak != null) {
                stats.push("Peak: " + Number(turn.peak).toFixed(4));
            }
            if (turn.no_speech_prob != null) {
                stats.push("No-speech: " + (Number(turn.no_speech_prob) * 100).toFixed(1) + "%");
            }
            if (turn.avg_logprob != null) {
                stats.push("Avg logprob: " + Number(turn.avg_logprob).toFixed(3));
            }
            if (stats.length > 0) {
                var statsDiv = document.createElement("div");
                statsDiv.className = "turn-stats";
                statsDiv.textContent = stats.join(" | ");
                card.appendChild(statsDiv);
            }
        } else {
            // Agent turn: show model and tool info
            var agentMeta = [];
            if (turn.model_used) {
                agentMeta.push("Model: " + turn.model_used);
            }
            if (turn.workflow_used) {
                agentMeta.push("Workflow: " + turn.workflow_used);
            }
            if (turn.tool_calls_json) {
                try {
                    var tools = JSON.parse(turn.tool_calls_json);
                    if (Array.isArray(tools) && tools.length > 0) {
                        agentMeta.push("Tools: " + tools.map(function (t) { return t.name || t; }).join(", "));
                    }
                } catch (_) {
                    agentMeta.push("Tools: " + turn.tool_calls_json);
                }
            }
            if (agentMeta.length > 0) {
                var metaStatsDiv = document.createElement("div");
                metaStatsDiv.className = "turn-stats";
                metaStatsDiv.textContent = agentMeta.join(" | ");
                card.appendChild(metaStatsDiv);
            }
        }

        turnsList.appendChild(card);
    });

    sessionDetailContent.appendChild(turnsList);
}

// Back button
if (backToListBtn) {
    backToListBtn.addEventListener("click", function () {
        sessionDetail.classList.add("hidden");
        sessionsList.classList.remove("hidden");
    });
}

// Refresh button
if (refreshSessionsBtn) {
    refreshSessionsBtn.addEventListener("click", function () {
        loadSessions();
    });
}

// Clear All button
if (clearAllBtn) {
    clearAllBtn.addEventListener("click", function () {
        if (!confirm("Delete ALL sessions? This cannot be undone.")) return;
        apiFetch("/api/admin/sessions", { method: "DELETE" })
            .then(function () {
                loadSessions();
            })
            .catch(function (e) {
                console.log("Clear sessions error:", e);
            });
    });
}

// Search input — debounced
if (sessionSearch) {
    sessionSearch.addEventListener("input", function () {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(function () {
            loadSessions();
        }, 300);
    });
}

// ---------------------------------------------------------------------------
// 4. Live Logs tab
// ---------------------------------------------------------------------------

let logWS = null;
let logPaused = false;
let logActiveLevel = "all";
let logSearchText = "";
let logLineCount = 0;
const LOG_MAX_LINES = 1000;
let logReconnectTimer = null;

function connectLogWS() {
    // Don't reconnect if already open
    if (logWS && (logWS.readyState === WebSocket.OPEN || logWS.readyState === WebSocket.CONNECTING)) {
        return;
    }

    clearTimeout(logReconnectTimer);

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    var wsAuth = adminToken
        ? "token=" + encodeURIComponent(adminToken)
        : "session_token=" + encodeURIComponent(sessionToken);
    const wsUrl = proto + "//" + location.host + "/admin/ws?" + wsAuth;

    try {
        logWS = new WebSocket(wsUrl);
    } catch (e) {
        console.log("Log WebSocket creation failed:", e);
        scheduleLogReconnect();
        return;
    }

    logWS.onopen = function () {
        console.log("Log WebSocket connected");
    };

    logWS.onmessage = function (ev) {
        appendLogLine(ev.data);
    };

    logWS.onclose = function () {
        console.log("Log WebSocket closed");
        logWS = null;
        // Only reconnect if we're still on the logs tab
        if (activeTab === "logs") {
            scheduleLogReconnect();
        }
    };

    logWS.onerror = function () {
        console.log("Log WebSocket error");
    };
}

function scheduleLogReconnect() {
    clearTimeout(logReconnectTimer);
    logReconnectTimer = setTimeout(function () {
        if (activeTab === "logs") {
            connectLogWS();
        }
    }, 3000);
}

function disconnectLogWS() {
    clearTimeout(logReconnectTimer);
    if (logWS) {
        logWS.onclose = null; // prevent reconnect
        logWS.close();
        logWS = null;
    }
}

function detectLogLevel(line) {
    // Parse standard Python log levels from the line
    if (/\bERROR\b/i.test(line)) return "error";
    if (/\bWARN(?:ING)?\b/i.test(line)) return "warn";
    if (/\bINFO\b/i.test(line)) return "info";
    if (/\bDEBUG\b/i.test(line)) return "debug";
    return "info"; // default
}

function appendLogLine(line) {
    if (!logOutput) return;

    var level = detectLogLevel(line);
    var span = document.createElement("span");
    span.className = "log-line log-level-" + level;
    span.dataset.level = level;
    span.textContent = line + "\n";

    // Apply current filters
    applyLineFilters(span);

    logOutput.appendChild(span);
    logLineCount++;

    // Prune old lines
    while (logLineCount > LOG_MAX_LINES) {
        var first = logOutput.firstChild;
        if (first) {
            logOutput.removeChild(first);
            logLineCount--;
        } else {
            break;
        }
    }

    // Auto-scroll unless paused
    if (!logPaused) {
        logOutput.scrollTop = logOutput.scrollHeight;
    }
}

function applyLineFilters(span) {
    var level = span.dataset.level;
    var text = span.textContent.toLowerCase();

    var levelVisible = true;
    if (logActiveLevel !== "all") {
        // Show lines at or above the selected severity
        var severity = { error: 0, warn: 1, info: 2, debug: 3 };
        var filterSev = severity[logActiveLevel] != null ? severity[logActiveLevel] : 2;
        var lineSev = severity[level] != null ? severity[level] : 2;
        levelVisible = lineSev <= filterSev;
    }

    var searchVisible = true;
    if (logSearchText) {
        searchVisible = text.includes(logSearchText.toLowerCase());
    }

    span.style.display = (levelVisible && searchVisible) ? "" : "none";
}

function refilterAllLogLines() {
    if (!logOutput) return;
    var spans = logOutput.querySelectorAll(".log-line");
    spans.forEach(function (span) {
        applyLineFilters(span);
    });
}

// Level filter buttons
levelBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
        logActiveLevel = btn.dataset.level || "all";
        levelBtns.forEach(function (b) {
            b.classList.toggle("active", b === btn);
        });
        refilterAllLogLines();
    });
});

// Log search filter
if (logSearch) {
    logSearch.addEventListener("input", function () {
        logSearchText = logSearch.value.trim();
        refilterAllLogLines();
    });
}

// Pause button
if (pauseLogsBtn) {
    pauseLogsBtn.addEventListener("click", function () {
        logPaused = !logPaused;
        pauseLogsBtn.textContent = logPaused ? "Resume" : "Pause";
        pauseLogsBtn.classList.toggle("active", logPaused);
        if (!logPaused && logOutput) {
            logOutput.scrollTop = logOutput.scrollHeight;
        }
    });
}

// ---------------------------------------------------------------------------
// 5. Tools tab
// ---------------------------------------------------------------------------

async function loadTools() {
    try {
        var tools = await apiFetch("/api/admin/tools");
        renderTools(tools);
    } catch (e) {
        console.log("loadTools error:", e);
        if (toolsList) {
            toolsList.textContent = "";
            var errP = document.createElement("p");
            errP.className = "error-msg";
            errP.textContent = "Failed to load tools.";
            toolsList.appendChild(errP);
        }
    }
}

function renderTools(tools) {
    if (!toolsList) return;

    toolsList.textContent = "";

    if (!tools || tools.length === 0) {
        var emptyP = document.createElement("p");
        emptyP.className = "empty-msg";
        emptyP.textContent = "No tools registered.";
        toolsList.appendChild(emptyP);
        return;
    }

    tools.forEach(function (tool) {
        var card = document.createElement("div");
        card.className = "tool-card " + (tool.enabled ? "tool-enabled" : "tool-disabled");

        var infoDiv = document.createElement("div");
        infoDiv.className = "tool-info";

        var nameEl = document.createElement("strong");
        nameEl.className = "tool-name";
        nameEl.textContent = tool.name;
        infoDiv.appendChild(nameEl);

        var descSpan = document.createElement("span");
        descSpan.className = "tool-desc";
        descSpan.textContent = tool.description || "";
        infoDiv.appendChild(descSpan);

        card.appendChild(infoDiv);

        var btn = document.createElement("button");
        btn.className = "toggle-btn " + (tool.enabled ? "toggle-on" : "toggle-off");
        btn.textContent = tool.enabled ? "ON" : "OFF";
        btn.addEventListener("click", function () {
            toggleTool(tool.name);
        });
        card.appendChild(btn);

        toolsList.appendChild(card);
    });
}

async function toggleTool(name) {
    try {
        await apiFetch("/api/admin/tools/" + encodeURIComponent(name) + "/toggle", {
            method: "POST",
        });
        loadTools();
    } catch (e) {
        console.log("toggleTool error:", e);
    }
}

// ---------------------------------------------------------------------------
// 6. Search Providers
// ---------------------------------------------------------------------------

async function loadSearchProviders() {
    try {
        var data = await apiFetch("/api/admin/search-providers");
        renderSearchProviders(data);
    } catch (e) {
        console.log("loadSearchProviders error:", e);
        if (searchProviders) {
            searchProviders.textContent = "";
            var errP = document.createElement("p");
            errP.className = "error-msg";
            errP.textContent = "Failed to load search providers.";
            searchProviders.appendChild(errP);
        }
    }
}

function renderSearchProviders(data) {
    if (!searchProviders) return;

    var masterEnabled = data.master_enabled;
    var providers = data.providers || [];

    searchProviders.textContent = "";

    // Master toggle card
    var masterCard = document.createElement("div");
    masterCard.className = "provider-card master-toggle";

    var masterInfo = document.createElement("div");
    masterInfo.className = "provider-info";

    var masterLabel = document.createElement("strong");
    masterLabel.textContent = "Web Search (Master)";
    masterInfo.appendChild(masterLabel);

    var masterDesc = document.createElement("span");
    masterDesc.className = "provider-desc";
    masterDesc.textContent = "Enable or disable all web search functionality";
    masterInfo.appendChild(masterDesc);

    masterCard.appendChild(masterInfo);

    var masterBtn = document.createElement("button");
    masterBtn.className = "toggle-btn " + (masterEnabled ? "toggle-on" : "toggle-off");
    masterBtn.textContent = masterEnabled ? "ON" : "OFF";
    masterBtn.addEventListener("click", function () {
        toggleSearchProvider("_master");
    });
    masterCard.appendChild(masterBtn);

    searchProviders.appendChild(masterCard);

    // Individual providers
    providers.forEach(function (p) {
        var provCard = document.createElement("div");
        provCard.className = "provider-card provider-nested" + (!masterEnabled ? " provider-dimmed" : "");

        var provInfo = document.createElement("div");
        provInfo.className = "provider-info";

        var provLabel = document.createElement("strong");
        provLabel.textContent = p.label || p.name;
        provInfo.appendChild(provLabel);
        provInfo.appendChild(document.createTextNode(" "));

        var keyBadge = document.createElement("span");
        keyBadge.className = "badge " + (p.has_key ? "badge-ok" : "badge-missing");
        keyBadge.textContent = p.has_key ? "Key Set" : "No Key";
        provInfo.appendChild(keyBadge);

        provCard.appendChild(provInfo);

        var provBtn = document.createElement("button");
        provBtn.className = "toggle-btn " + (p.enabled ? "toggle-on" : "toggle-off");
        provBtn.textContent = p.enabled ? "ON" : "OFF";
        provBtn.disabled = !masterEnabled;
        provBtn.addEventListener("click", function () {
            if (!provBtn.disabled) {
                toggleSearchProvider(p.name);
            }
        });
        provCard.appendChild(provBtn);

        searchProviders.appendChild(provCard);
    });
}

async function toggleSearchProvider(name) {
    try {
        await apiFetch("/api/admin/search-providers/" + encodeURIComponent(name) + "/toggle", {
            method: "POST",
        });
        loadSearchProviders();
    } catch (e) {
        console.log("toggleSearchProvider error:", e);
    }
}

// ---------------------------------------------------------------------------
// 7. RAG Endpoints
// ---------------------------------------------------------------------------

async function loadRagEndpoints() {
    try {
        var endpoints = await apiFetch("/api/admin/rag");
        renderRagEndpoints(endpoints);
    } catch (e) {
        console.log("loadRagEndpoints error:", e);
        if (ragList) {
            ragList.textContent = "";
            var errP = document.createElement("p");
            errP.className = "error-msg";
            errP.textContent = "Failed to load RAG endpoints.";
            ragList.appendChild(errP);
        }
    }
}

function renderRagEndpoints(endpoints) {
    if (!ragList) return;

    ragList.textContent = "";

    if (!endpoints || endpoints.length === 0) {
        var emptyP = document.createElement("p");
        emptyP.className = "empty-msg";
        emptyP.textContent = "No RAG endpoints configured.";
        ragList.appendChild(emptyP);
        return;
    }

    endpoints.forEach(function (ep) {
        // Health dot: green if last_health within 5 minutes, orange if stale, red if unknown
        var healthColor = "red";
        var healthTitle = "Unknown";
        if (ep.last_health) {
            var elapsed = Date.now() - new Date(ep.last_health).getTime();
            if (elapsed < 5 * 60 * 1000) {
                healthColor = "green";
                healthTitle = "Healthy (" + formatTime(ep.last_health) + ")";
            } else {
                healthColor = "orange";
                healthTitle = "Stale (" + formatTime(ep.last_health) + ")";
            }
        }

        var card = document.createElement("div");
        card.className = "rag-card" + (ep.active ? "" : " rag-inactive");

        // Header: health dot + name
        var headerDiv = document.createElement("div");
        headerDiv.className = "rag-header";

        var dot = document.createElement("span");
        dot.className = "health-dot health-" + healthColor;
        dot.title = healthTitle;
        headerDiv.appendChild(dot);

        var nameEl = document.createElement("strong");
        nameEl.className = "rag-name";
        nameEl.textContent = ep.name;
        headerDiv.appendChild(nameEl);

        card.appendChild(headerDiv);

        // URL
        var urlDiv = document.createElement("div");
        urlDiv.className = "rag-url";
        urlDiv.textContent = ep.url;
        card.appendChild(urlDiv);

        // Description
        if (ep.description) {
            var descDiv = document.createElement("div");
            descDiv.className = "rag-desc";
            descDiv.textContent = ep.description;
            card.appendChild(descDiv);
        }

        // Action buttons
        var actionsDiv = document.createElement("div");
        actionsDiv.className = "rag-actions";

        var healthBtn = document.createElement("button");
        healthBtn.className = "btn-sm btn-secondary rag-health-btn";
        healthBtn.textContent = "Health Check";
        healthBtn.addEventListener("click", function () {
            ragHealthCheck(ep.id, healthBtn);
        });
        actionsDiv.appendChild(healthBtn);

        if (ep.upload_url) {
            actionsDiv.appendChild(document.createTextNode(" "));
            var configLink = document.createElement("a");
            configLink.className = "btn-sm btn-secondary";
            configLink.href = ep.upload_url;
            configLink.target = "_blank";
            configLink.rel = "noopener";
            configLink.textContent = "Configure";
            actionsDiv.appendChild(configLink);
        }

        actionsDiv.appendChild(document.createTextNode(" "));
        var deleteBtn = document.createElement("button");
        deleteBtn.className = "btn-sm btn-danger rag-delete-btn";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", function () {
            deleteRagEndpoint(ep.id);
        });
        actionsDiv.appendChild(deleteBtn);

        card.appendChild(actionsDiv);
        ragList.appendChild(card);
    });
}

async function ragHealthCheck(id, btn) {
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Checking...";
    }
    try {
        var result = await apiFetch("/api/admin/rag/" + encodeURIComponent(id) + "/health", {
            method: "POST",
        });
        if (btn) {
            btn.textContent = result.healthy ? "Healthy" : "Unhealthy";
            btn.classList.toggle("btn-success", result.healthy);
        }
        // Reload to update health dot
        setTimeout(function () { loadRagEndpoints(); }, 1500);
    } catch (e) {
        console.log("ragHealthCheck error:", e);
        if (btn) {
            btn.textContent = "Error";
            btn.disabled = false;
        }
    }
}

async function deleteRagEndpoint(id) {
    if (!confirm("Delete this RAG endpoint?")) return;
    try {
        await apiFetch("/api/admin/rag/" + encodeURIComponent(id), {
            method: "DELETE",
        });
        loadRagEndpoints();
    } catch (e) {
        console.log("deleteRagEndpoint error:", e);
    }
}

// Add RAG form toggle
if (addRagBtn) {
    addRagBtn.addEventListener("click", function () {
        if (ragForm) ragForm.classList.remove("hidden");
    });
}

if (cancelRagBtn) {
    cancelRagBtn.addEventListener("click", function () {
        if (ragForm) ragForm.classList.add("hidden");
        clearRagForm();
    });
}

if (saveRagBtn) {
    saveRagBtn.addEventListener("click", function () {
        saveRagEndpoint();
    });
}

function clearRagForm() {
    var nameInput = document.getElementById("rag-name");
    var urlInput = document.getElementById("rag-url");
    var descInput = document.getElementById("rag-description");
    var uploadInput = document.getElementById("rag-upload-url");
    if (nameInput) nameInput.value = "";
    if (urlInput) urlInput.value = "";
    if (descInput) descInput.value = "";
    if (uploadInput) uploadInput.value = "";
}

async function saveRagEndpoint() {
    var nameInput = document.getElementById("rag-name");
    var urlInput = document.getElementById("rag-url");
    var descInput = document.getElementById("rag-description");
    var uploadInput = document.getElementById("rag-upload-url");

    var name = nameInput ? nameInput.value.trim() : "";
    var url = urlInput ? urlInput.value.trim() : "";
    var description = descInput ? descInput.value.trim() : "";
    var uploadUrl = uploadInput ? uploadInput.value.trim() : "";

    if (!name || !url) {
        alert("Name and URL are required.");
        return;
    }

    try {
        await apiFetch("/api/admin/rag", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: name,
                url: url,
                description: description,
                upload_url: uploadUrl,
            }),
        });
        if (ragForm) ragForm.classList.add("hidden");
        clearRagForm();
        loadRagEndpoints();
    } catch (e) {
        console.log("saveRagEndpoint error:", e);
        alert("Failed to save RAG endpoint: " + e.message);
    }
}

// ---------------------------------------------------------------------------
// 8. Config tab
// ---------------------------------------------------------------------------

async function loadConfig() {
    try {
        var data = await apiFetch("/api/admin/config");
        renderConfig(data);
    } catch (e) {
        console.log("loadConfig error:", e);
        if (serverInfo) {
            serverInfo.textContent = "";
            var errP = document.createElement("p");
            errP.className = "error-msg";
            errP.textContent = "Failed to load config.";
            serverInfo.appendChild(errP);
        }
    }
}

function renderConfig(data) {
    var config = data.config || {};
    var server = data.server || {};
    var llm = data.llm || {};

    // Server info — built with DOM API
    if (serverInfo) {
        serverInfo.textContent = "";
        var grid = document.createElement("div");
        grid.className = "config-grid";

        var serverItems = [
            { label: "Uptime", value: formatUptime(server.uptime) },
            { label: "Port", value: String(server.port) },
            { label: "HTTPS", value: server.https ? "Enabled" : "Disabled" },
            { label: "Log Size", value: formatBytes(server.log_size_bytes) },
        ];
        serverItems.forEach(function (item) {
            var row = document.createElement("div");
            row.className = "config-item";
            var lbl = document.createElement("span");
            lbl.className = "config-label";
            lbl.textContent = item.label;
            row.appendChild(lbl);
            var val = document.createElement("span");
            val.className = "config-value";
            val.textContent = item.value;
            row.appendChild(val);
            grid.appendChild(row);
        });
        serverInfo.appendChild(grid);
    }

    // Update header uptime
    if (serverUptime) {
        serverUptime.textContent = "Uptime: " + formatUptime(server.uptime);
    }

    // LLM defaults — built with DOM API
    if (llmConfig) {
        llmConfig.textContent = "";
        var llmGrid = document.createElement("div");
        llmGrid.className = "config-grid";

        // Text items
        var llmTextItems = [
            { label: "Default Provider", value: config.default_llm_provider || "auto" },
            { label: "Default Model", value: config.default_llm_model || "auto" },
            { label: "Ollama URL", value: llm.ollama_url || "--" },
        ];
        llmTextItems.forEach(function (item) {
            var row = document.createElement("div");
            row.className = "config-item";
            var lbl = document.createElement("span");
            lbl.className = "config-label";
            lbl.textContent = item.label;
            row.appendChild(lbl);
            var val = document.createElement("span");
            val.className = "config-value";
            val.textContent = item.value;
            row.appendChild(val);
            llmGrid.appendChild(row);
        });

        // Badge items (API keys)
        var keyItems = [
            { label: "Anthropic API Key", set: llm.anthropic_key_set },
            { label: "OpenAI API Key", set: llm.openai_key_set },
        ];
        keyItems.forEach(function (item) {
            var row = document.createElement("div");
            row.className = "config-item";
            var lbl = document.createElement("span");
            lbl.className = "config-label";
            lbl.textContent = item.label;
            row.appendChild(lbl);
            var val = document.createElement("span");
            val.className = "config-value";
            var badge = document.createElement("span");
            badge.className = "badge " + (item.set ? "badge-ok" : "badge-missing");
            badge.textContent = item.set ? "Configured" : "Missing";
            val.appendChild(badge);
            row.appendChild(val);
            llmGrid.appendChild(row);
        });

        llmConfig.appendChild(llmGrid);
    }

    // Search quota section
    if (searchQuota) {
        searchQuota.textContent = "";
        var sqGrid = document.createElement("div");
        sqGrid.className = "config-grid";
        var sqRow = document.createElement("div");
        sqRow.className = "config-item";
        var sqLabel = document.createElement("span");
        sqLabel.className = "config-label";
        sqLabel.textContent = "Web Search";
        sqRow.appendChild(sqLabel);
        var sqValue = document.createElement("span");
        sqValue.className = "config-value";
        sqValue.textContent = config.web_search_enabled || "true";
        sqRow.appendChild(sqValue);
        sqGrid.appendChild(sqRow);
        searchQuota.appendChild(sqGrid);
    }

    // Update download log link
    if (downloadLogLink) {
        var dlAuth = adminToken
            ? "token=" + encodeURIComponent(adminToken)
            : "session_token=" + encodeURIComponent(sessionToken);
        downloadLogLink.href = "/api/admin/logs?limit=99999&" + dlAuth;
    }
}

// ---------------------------------------------------------------------------
// Cleanup on page unload
// ---------------------------------------------------------------------------

window.addEventListener("beforeunload", function () {
    disconnectLogWS();
});
