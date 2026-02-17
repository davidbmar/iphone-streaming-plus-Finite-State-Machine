"use strict";

// --- DOM refs ---
const connectScreen = document.getElementById("connect-screen");
const agentScreen = document.getElementById("agent-screen");
const tokenInput = document.getElementById("token-input");
const connectBtn = document.getElementById("connect-btn");
const connectStatus = document.getElementById("connect-status");
const conversationLog = document.getElementById("conversation-log");
const talkBtn = document.getElementById("talk-btn");
const stopBtn = document.getElementById("stop-btn");
const providerSelect = document.getElementById("provider-select");
const voiceSelect = document.getElementById("voice-select");
const downloadBar = document.getElementById("download-bar");
const downloadLabel = document.getElementById("download-label");
const downloadFill = document.getElementById("download-fill");
const searchToggle = document.getElementById("search-toggle");
const debugToggle = document.getElementById("debug-toggle");
const debugPanels = document.getElementById("debug-panels");
const debugBackdrop = document.getElementById("debug-backdrop");
const workflowMapContainer = document.getElementById("workflow-map");
const workflowCodeContainer = document.getElementById("workflow-code");
const connectProgress = document.getElementById("connect-progress");
const connectProgressLabel = document.getElementById("connect-progress-label");

// --- State ---
let iceServers = window.__CONFIG__ || [];
let ws = null;
let pc = null;
let audioEl = null;
let micStream = null;
let isRecording = false;
let agentSpeaking = false;
let currentSelectValue = ""; // Track previous select value for download revert
let pendingDownloadModel = ""; // Model currently being downloaded (for auto-select)
let currentVoice = ""; // Currently selected TTS voice
let searchEnabled = true; // Web search toggle
let debugVisible = false; // Workflow debugger panel visibility
let activeWorkflowId = ""; // Currently running workflow ID

// Workflow activity card state
let workflowCard = null;
let workflowTimerInterval = null;
let workflowTimerStart = 0;
let workflowCurrentTimeout = 0;
let workflowStepInfo = {};   // {step, total, stepName, stateId}
let workflowName = "";
let workflowStates = [];

// --- Markdown to safe DOM nodes (for agent chat bubbles) ---
// Uses DOM API (createElement/textContent) exclusively — no innerHTML.
function renderMarkdown(container, text) {
    const paragraphs = text.split(/\n{2,}/);
    paragraphs.forEach((para) => {
        const trimmed = para.trim();
        if (!trimmed) return;
        const lines = trimmed.split("\n");
        const isList = lines.every(
            (l) => /^\s*[-*•]\s+/.test(l) || /^\s*\d+\.\s+/.test(l) || !l.trim()
        );
        if (isList) {
            const ul = document.createElement("ul");
            ul.style.margin = "4px 0";
            ul.style.paddingLeft = "18px";
            lines.forEach((line) => {
                const content = line.replace(/^\s*[-*•]\s+/, "").replace(/^\s*\d+\.\s+/, "").trim();
                if (content) {
                    const li = document.createElement("li");
                    renderInline(li, content);
                    ul.appendChild(li);
                }
            });
            container.appendChild(ul);
        } else {
            const p = document.createElement("p");
            p.style.margin = "4px 0";
            renderInline(p, lines.join(" "));
            container.appendChild(p);
        }
    });
}

function renderInline(el, text) {
    // Process inline markdown + raw URLs into safe DOM nodes
    // Order matters: markdown links before raw URLs, bold before italic
    const pattern = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[([^\]]+)\]\(([^)]+)\))|(https?:\/\/[^\s),]+)/g;
    let lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > lastIndex) {
            el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        if (match[1]) {
            const strong = document.createElement("strong");
            strong.textContent = match[2];
            el.appendChild(strong);
        } else if (match[3]) {
            const em = document.createElement("em");
            em.textContent = match[4];
            el.appendChild(em);
        } else if (match[5]) {
            const code = document.createElement("code");
            code.textContent = match[6];
            el.appendChild(code);
        } else if (match[7]) {
            // Markdown link: [text](url)
            const a = document.createElement("a");
            a.textContent = match[8];
            a.href = match[9];
            a.target = "_blank";
            a.rel = "noopener";
            el.appendChild(a);
        } else if (match[10]) {
            // Raw URL: https://example.com
            const a = document.createElement("a");
            // Show shortened domain as link text
            try {
                const url = new URL(match[10]);
                a.textContent = url.hostname.replace("www.", "");
            } catch {
                a.textContent = match[10];
            }
            a.href = match[10];
            a.target = "_blank";
            a.rel = "noopener";
            el.appendChild(a);
        }
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
        el.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
}

// --- Chat bubble helpers ---
function addChatBubble(text, role) {
    const thinking = conversationLog.querySelector(".thinking");
    if (thinking) thinking.remove();

    const bubble = document.createElement("div");
    bubble.className = "msg msg-" + role;
    if (role === "agent") {
        renderMarkdown(bubble, text);
    } else {
        bubble.textContent = text;
    }
    conversationLog.appendChild(bubble);
    conversationLog.scrollTop = conversationLog.scrollHeight;
}

function showThinking() {
    const el = document.createElement("div");
    el.className = "msg msg-agent thinking";
    el.textContent = "Thinking...";
    conversationLog.appendChild(el);
    conversationLog.scrollTop = conversationLog.scrollHeight;
}

function setAgentSpeaking(speaking) {
    agentSpeaking = speaking;
    if (speaking) {
        stopBtn.classList.remove("hidden");
    } else {
        stopBtn.classList.add("hidden");
    }
}

// --- Search ping sound (Web Audio API — no file needed) ---
function playSearchPing() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880; // A5 note
        osc.type = "sine";
        gain.gain.value = 0.15;
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
        // Audio context not available — skip silently
    }
}

// --- Model select population ---
function populateModelSelect(catalog, defaultProvider, defaultModel) {
    while (providerSelect.firstChild) providerSelect.removeChild(providerSelect.firstChild);

    // Section 1: Installed Local Models
    if (catalog.ollama_installed && catalog.ollama_installed.length > 0) {
        const grp = document.createElement("optgroup");
        grp.label = "Installed Local Models";
        catalog.ollama_installed.forEach((m) => {
            const opt = document.createElement("option");
            opt.value = "ollama:" + m.name;
            // Use friendly label + params if available, fall back to raw name
            opt.textContent = m.label
                ? m.label + " " + m.params + " (" + m.size_label + ")"
                : m.name + " (" + m.size_label + ")";
            grp.appendChild(opt);
        });
        providerSelect.appendChild(grp);
    }

    // Section 2: Download Local Model (curated not-yet-installed)
    if (catalog.ollama_online && catalog.ollama_available && catalog.ollama_available.length > 0) {
        const grp = document.createElement("optgroup");
        grp.label = "Download Local Model";
        catalog.ollama_available.forEach((m) => {
            const opt = document.createElement("option");
            opt.value = "download:" + m.name;
            opt.textContent = "\u2B07 " + m.label + " (" + m.params + ")";
            opt.className = "download-option";
            grp.appendChild(opt);
        });
        providerSelect.appendChild(grp);
    }

    // Section 3: Cloud APIs
    if (catalog.cloud_providers && catalog.cloud_providers.length > 0) {
        const grp = document.createElement("optgroup");
        grp.label = "Cloud APIs";
        catalog.cloud_providers.forEach((p) => {
            const opt = document.createElement("option");
            opt.value = p.provider + ":" + (p.model || "");
            opt.textContent = p.name;
            grp.appendChild(opt);
        });
        providerSelect.appendChild(grp);
    }

    // Set default selection
    let targetValue = "";
    if (defaultProvider === "ollama" && defaultModel) {
        targetValue = "ollama:" + defaultModel;
    } else if (defaultProvider && defaultProvider !== "ollama") {
        // Find matching cloud provider option
        for (const opt of providerSelect.options) {
            if (opt.value.startsWith(defaultProvider + ":")) {
                targetValue = opt.value;
                break;
            }
        }
    }
    if (targetValue) {
        providerSelect.value = targetValue;
    }
    currentSelectValue = providerSelect.value;
}

// --- Download progress ---
function showDownloadProgress(model, percent, status) {
    downloadBar.classList.remove("hidden");
    downloadLabel.textContent = model + ": " + (status || "downloading...");
    downloadFill.style.width = percent + "%";
}

function hideDownloadProgress() {
    downloadBar.classList.add("hidden");
    downloadFill.style.width = "0%";
    downloadLabel.textContent = "";
}

// --- Voice select population ---
function populateVoiceSelect(voices, defaultVoice) {
    while (voiceSelect.firstChild) voiceSelect.removeChild(voiceSelect.firstChild);

    const downloaded = voices.filter((v) => v.downloaded);
    const available = voices.filter((v) => !v.downloaded);

    if (downloaded.length > 0) {
        const grp = document.createElement("optgroup");
        grp.label = "Downloaded Voices";
        downloaded.forEach((v) => {
            const opt = document.createElement("option");
            opt.value = v.id;
            opt.textContent = v.name;
            grp.appendChild(opt);
        });
        voiceSelect.appendChild(grp);
    }

    if (available.length > 0) {
        const grp = document.createElement("optgroup");
        grp.label = "Download on First Use";
        available.forEach((v) => {
            const opt = document.createElement("option");
            opt.value = v.id;
            opt.textContent = "\u2B07 " + v.name;
            grp.appendChild(opt);
        });
        voiceSelect.appendChild(grp);
    }

    if (defaultVoice) {
        voiceSelect.value = defaultVoice;
    }
    currentVoice = voiceSelect.value;
}

// --- WebSocket ---
function sendMsg(type, payload = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type, ...payload }));
}

function connect() {
    const token = tokenInput.value.trim();
    if (!token) { setStatus("Enter a token", true); return; }

    connectBtn.disabled = true;
    setStatus("Connecting...");
    setConnectProgress(1);

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        setStatus("Authenticating...");
        setConnectProgress(2);
        sendMsg("hello", { token });
    };

    ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        try {
            handleMessage(msg);
        } catch (err) {
            console.error("handleMessage error:", err);
            setStatus("Client error: " + err.message, true);
        }
    };

    ws.onerror = () => {
        setStatus("Connection failed", true);
        connectBtn.disabled = false;
        hideConnectProgress();
    };

    ws.onclose = () => {
        if (!agentScreen.classList.contains("hidden")) {
            agentScreen.classList.add("hidden");
            connectScreen.classList.remove("hidden");
        }
        setStatus("Disconnected", true);
        connectBtn.disabled = false;
        hideConnectProgress();
        cleanupWebRTC();
    };
}

function setStatus(text, isError) {
    connectStatus.textContent = text;
    connectStatus.className = "connect-status" + (isError ? " error" : "");
}

// Connection stages: 1=WS  2=Auth  3=Mic  4=ICE  5=Connected
var connectStageLabels = ["", "Opening channel", "Authenticating", "Microphone access", "Negotiating audio", "Link established"];

function setConnectProgress(stage) {
    if (!connectProgress) return;
    connectProgress.classList.remove("hidden");
    var segs = connectProgress.querySelectorAll(".cp-seg");
    for (var i = 0; i < segs.length; i++) {
        segs[i].classList.remove("done", "active");
        if (i < stage - 1) {
            segs[i].classList.add("done");
        } else if (i === stage - 1) {
            segs[i].classList.add("active");
        }
    }
    if (connectProgressLabel) {
        connectProgressLabel.textContent = connectStageLabels[stage] || "";
    }
}

function hideConnectProgress() {
    if (connectProgress) connectProgress.classList.add("hidden");
}

function handleMessage(msg) {
    switch (msg.type) {
        case "hello_ack":
            if (msg.ice_servers && msg.ice_servers.length > 0) {
                iceServers = msg.ice_servers;
            }
            // Populate TTS voice selector
            if (msg.tts_voices) {
                populateVoiceSelect(msg.tts_voices, msg.tts_default_voice || "");
            }
            // Populate grouped model selector
            if (msg.model_catalog) {
                populateModelSelect(
                    msg.model_catalog,
                    msg.llm_default_provider || msg.llm_default || "",
                    msg.llm_default_model || ""
                );
            } else if (msg.llm_providers) {
                // Backward compat: flat provider list
                while (providerSelect.firstChild) providerSelect.removeChild(providerSelect.firstChild);
                msg.llm_providers.forEach((p) => {
                    const opt = document.createElement("option");
                    opt.value = p.id + ":";
                    opt.textContent = p.name;
                    if (p.id === msg.llm_default) opt.selected = true;
                    providerSelect.appendChild(opt);
                });
                currentSelectValue = providerSelect.value;
            }
            // Sync search toggle state from server
            if (msg.search_enabled !== undefined) {
                searchEnabled = msg.search_enabled;
                searchToggle.classList.toggle("active", searchEnabled);
            }
            startWebRTC();
            break;

        case "webrtc_answer":
            handleWebRTCAnswer(msg.sdp);
            break;

        case "transcription":
            if (!msg.partial && msg.text) {
                addChatBubble(msg.text, "user");
            }
            break;

        case "agent_searching":
            playSearchPing();
            {
                const searchEl = document.createElement("div");
                searchEl.className = "msg msg-agent searching";
                searchEl.textContent = "Searching the web\u2026";
                conversationLog.appendChild(searchEl);
                conversationLog.scrollTop = conversationLog.scrollHeight;
            }
            break;

        case "agent_thinking":
            {
                const searching = conversationLog.querySelector(".searching");
                if (searching) searching.remove();
            }
            showThinking();
            break;

        case "agent_reply":
            // Dismiss workflow card before showing final answer
            dismissWorkflowCard();
            // Remove narration bubble
            {
                var narr = conversationLog.querySelector(".msg-narration");
                if (narr) narr.remove();
            }
            addChatBubble(msg.text, "agent");
            setAgentSpeaking(true);
            // If no workflow was active, clean up any stale workflow UI
            if (!activeWorkflowId) {
                hideDebugPanels();
            }
            break;

        case "workflow_start":
            activeWorkflowId = msg.workflow_id || "";
            workflowName = (msg.name || "WORKFLOW").toUpperCase();
            workflowStates = msg.states || [];
            // Render workflow graph and code view
            if (window.WorkflowMap && workflowMapContainer) {
                window.WorkflowMap.render(workflowMapContainer, msg);
            }
            if (window.WorkflowCode && workflowCodeContainer) {
                window.WorkflowCode.render(workflowCodeContainer, msg);
            }
            // Auto-show debug panels
            showDebugPanels();
            // Show activity card in chat
            showWorkflowCard();
            break;

        case "workflow_narration":
            if (workflowCard) {
                // Update activity text inside the card
                var actEl = workflowCard.querySelector(".wfc-activity");
                if (actEl) actEl.textContent = msg.text || "";
            } else {
                showNarrationBubble(msg.text || "");
            }
            break;

        case "workflow_state":
            // Highlight active/visited node in graph
            if (window.WorkflowMap) {
                window.WorkflowMap.highlight(
                    msg.state_id,
                    msg.status,
                    msg.detail || ""
                );
            }
            // Highlight code block
            if (msg.status === "active" && window.WorkflowCode) {
                window.WorkflowCode.highlight(msg.state_id);
            }
            // Update activity card step progress
            if (msg.status === "active" && msg.step && msg.total) {
                updateWorkflowCardStep(msg.step, msg.total, msg.step_name || "", msg.state_id || "");
            }
            break;

        case "workflow_activity":
            updateWorkflowCardActivity(msg.activity || "", msg.timeout_secs || 0);
            break;

        case "workflow_debug":
            updateWorkflowCardDebug(msg);
            break;

        case "workflow_loop_update":
            if (window.WorkflowMap) {
                window.WorkflowMap.updateLoop(
                    msg.state_id,
                    msg.children || [],
                    typeof msg.active_index === "number" ? msg.active_index : -1
                );
            }
            // Update activity card step label with loop iteration
            if (workflowCard && typeof msg.active_index === "number" && msg.active_index >= 0) {
                var label = workflowCard.querySelector(".wfc-step-label");
                var childCount = (msg.children || []).length;
                if (label && workflowStepInfo.step) {
                    label.textContent = "Step " + workflowStepInfo.step + " of " + workflowStepInfo.total +
                        " \u2014 " + (workflowStepInfo.stepName || "").toUpperCase() +
                        " (" + (msg.active_index + 1) + "/" + childCount + ")";
                }
            }
            break;

        case "workflow_exit":
            activeWorkflowId = "";
            // Flash exit node
            if (window.WorkflowMap) {
                window.WorkflowMap.highlight("__exit__", "active", "");
                setTimeout(function () {
                    window.WorkflowMap.highlight("__exit__", "visited", "");
                }, 2000);
            }
            dismissWorkflowCard();
            break;

        case "pull_started":
            pendingDownloadModel = msg.model;
            showDownloadProgress(msg.model, 0, "starting...");
            break;

        case "pull_progress":
            showDownloadProgress(msg.model, msg.percent || 0, msg.status || "downloading...");
            break;

        case "pull_complete":
            showDownloadProgress(msg.model, 100, "complete!");
            setTimeout(hideDownloadProgress, 1500);
            break;

        case "pull_error":
            hideDownloadProgress();
            console.error("Model pull failed:", msg.model, msg.message);
            break;

        case "model_catalog_update":
            if (msg.model_catalog) {
                const prevValue = currentSelectValue;
                populateModelSelect(msg.model_catalog, "ollama", "");
                // Auto-select the just-downloaded model if we know which one it was
                if (pendingDownloadModel) {
                    const autoVal = "ollama:" + pendingDownloadModel;
                    providerSelect.value = autoVal;
                    currentSelectValue = autoVal;
                    sendMsg("set_model", { provider: "ollama", model: pendingDownloadModel });
                    pendingDownloadModel = "";
                } else {
                    providerSelect.value = prevValue;
                    currentSelectValue = prevValue;
                }
            }
            break;

        case "model_set":
        case "provider_set":
            // Clear chat when model changes so the new model starts fresh
            while (conversationLog.firstChild) conversationLog.removeChild(conversationLog.firstChild);
            break;

        case "voice_set":
            currentVoice = msg.voice_id || currentVoice;
            if (msg.tts_voices) {
                populateVoiceSelect(msg.tts_voices, currentVoice);
            }
            break;

        case "search_enabled_set":
            searchEnabled = msg.enabled;
            searchToggle.classList.toggle("active", searchEnabled);
            break;

        case "error":
            console.error("Server error:", msg.message);
            break;

        case "pong":
            break;
    }
}

// --- WebRTC ---
async function startWebRTC() {
    setStatus("Setting up mic...");
    setConnectProgress(3);

    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        setStatus("Mic access denied", true);
        connectBtn.disabled = false;
        hideConnectProgress();
        return;
    }

    setStatus("Connecting audio...");
    setConnectProgress(4);

    try {
    const config = { iceServers: iceServers.length > 0 ? iceServers : undefined };
    pc = new RTCPeerConnection(config);

    const micTrack = micStream.getAudioTracks()[0];
    pc.addTrack(micTrack, micStream);

    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log("ICE state:", state);
        if (state === "connected" || state === "completed") {
            setConnectProgress(5);
            setTimeout(function () {
                hideConnectProgress();
                connectScreen.classList.add("hidden");
                agentScreen.classList.remove("hidden");
            }, 400);
            talkBtn.disabled = false;

            if (audioEl) {
                audioEl.play().catch(() => {});
            }
        } else if (state === "failed") {
            setStatus("Audio connection failed — check network", true);
            connectBtn.disabled = false;
            hideConnectProgress();
            cleanupWebRTC();
        } else if (state === "disconnected") {
            setStatus("Audio disconnected — reconnecting...", true);
        }
    };

    pc.ontrack = (ev) => {
        if (audioEl) { audioEl.srcObject = null; audioEl.remove(); }
        audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.srcObject = ev.streams[0] || new MediaStream([ev.track]);
        document.body.appendChild(audioEl);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    sendMsg("webrtc_offer", { sdp: pc.localDescription.sdp });
    } catch (err) {
        console.error("WebRTC setup error:", err);
        setStatus("WebRTC error: " + err.message, true);
        connectBtn.disabled = false;
        hideConnectProgress();
    }
}

function waitForIceGathering(pc) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") { resolve(); return; }
        const timer = setTimeout(() => {
            console.warn("ICE gathering timed out after 10s, proceeding with partial candidates");
            resolve();
        }, 10000);
        pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === "complete") {
                clearTimeout(timer);
                resolve();
            }
        };
    });
}

async function handleWebRTCAnswer(sdp) {
    if (!pc) return;
    await pc.setRemoteDescription({ type: "answer", sdp });
}

function cleanupWebRTC() {
    if (pc) { pc.close(); pc = null; }
    if (audioEl) { audioEl.srcObject = null; audioEl.remove(); audioEl = null; }
    if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
    }
    isRecording = false;
    talkBtn.textContent = "Hold to Speak";
    talkBtn.classList.remove("recording");
    talkBtn.disabled = true;
    setAgentSpeaking(false);
    hideDownloadProgress();
}

// --- Hold to Talk ---
function startTalking() {
    if (!micStream || isRecording) return;
    isRecording = true;
    talkBtn.classList.add("recording");
    talkBtn.textContent = "Transmitting\u2026";

    // Stop any current agent audio
    if (agentSpeaking) {
        sendMsg("stop_speaking");
        setAgentSpeaking(false);
    }

    sendMsg("mic_start");
}

function stopTalking() {
    if (!isRecording) return;
    isRecording = false;
    talkBtn.classList.remove("recording");
    talkBtn.textContent = "Hold to Speak";
    sendMsg("mic_stop");
}

// --- Stop agent audio ---
function stopSpeaking() {
    sendMsg("stop_speaking");
    setAgentSpeaking(false);
}

// --- Debug panel helpers ---
function showDebugPanels() {
    if (debugPanels) {
        debugPanels.classList.add("visible");
        if (debugBackdrop) debugBackdrop.classList.add("visible");
        debugVisible = true;
        debugToggle.classList.add("active");
    }
}

function hideDebugPanels() {
    if (debugPanels) {
        debugPanels.classList.remove("visible");
        if (debugBackdrop) debugBackdrop.classList.remove("visible");
        debugVisible = false;
        debugToggle.classList.remove("active");
    }
}

function toggleDebugPanels() {
    if (debugVisible) {
        hideDebugPanels();
    } else {
        showDebugPanels();
    }
}

// --- Workflow Activity Card (persistent in-chat card) ---

function showWorkflowCard() {
    // Remove stale indicators
    var el;
    el = conversationLog.querySelector(".thinking"); if (el) el.remove();
    el = conversationLog.querySelector(".searching"); if (el) el.remove();
    el = conversationLog.querySelector(".msg-narration"); if (el) el.remove();

    // Don't create duplicate
    if (workflowCard) workflowCard.remove();

    var card = document.createElement("div");
    card.className = "workflow-card";

    // Header
    var header = document.createElement("div");
    header.className = "wfc-header";
    header.textContent = workflowName || "WORKFLOW";
    card.appendChild(header);

    // Segmented progress bar
    var progress = document.createElement("div");
    progress.className = "wfc-progress";
    var segCount = workflowStates.length || 4;
    for (var i = 0; i < segCount; i++) {
        var seg = document.createElement("div");
        seg.className = "wfc-segment";
        seg.dataset.idx = i;
        progress.appendChild(seg);
    }
    card.appendChild(progress);

    // Step label
    var stepLabel = document.createElement("div");
    stepLabel.className = "wfc-step-label";
    stepLabel.textContent = "";
    card.appendChild(stepLabel);

    // Activity text
    var activity = document.createElement("div");
    activity.className = "wfc-activity";
    activity.textContent = "";
    card.appendChild(activity);

    // Timer row
    var timerRow = document.createElement("div");
    timerRow.className = "wfc-timer-row";

    var timerTrack = document.createElement("div");
    timerTrack.className = "wfc-timer-track";
    var timerFill = document.createElement("div");
    timerFill.className = "wfc-timer-fill";
    timerTrack.appendChild(timerFill);

    var timerText = document.createElement("div");
    timerText.className = "wfc-timer-text";
    timerText.textContent = "";

    timerRow.appendChild(timerTrack);
    timerRow.appendChild(timerText);
    card.appendChild(timerRow);

    // Debug info row
    var debugRow = document.createElement("div");
    debugRow.className = "wfc-debug";
    debugRow.textContent = "";
    card.appendChild(debugRow);

    conversationLog.appendChild(card);
    conversationLog.scrollTop = conversationLog.scrollHeight;
    workflowCard = card;
}

function updateWorkflowCardStep(step, total, stepName, stateId) {
    if (!workflowCard) return;
    workflowStepInfo = { step: step, total: total, stepName: stepName, stateId: stateId };

    // Update progress segments
    var segs = workflowCard.querySelectorAll(".wfc-segment");
    for (var i = 0; i < segs.length; i++) {
        segs[i].classList.remove("active", "visited");
        if (i < step - 1) {
            segs[i].classList.add("visited");
        } else if (i === step - 1) {
            segs[i].classList.add("active");
        }
    }

    // Update step label
    var label = workflowCard.querySelector(".wfc-step-label");
    if (label) {
        label.textContent = "Step " + step + " of " + total + " \u2014 " + (stepName || stateId || "").toUpperCase();
    }
}

function updateWorkflowCardActivity(activity, timeoutSecs) {
    if (!workflowCard) return;

    // Update activity text
    var actEl = workflowCard.querySelector(".wfc-activity");
    if (actEl) actEl.textContent = activity;

    // Reset timer
    clearInterval(workflowTimerInterval);
    workflowTimerStart = Date.now();
    workflowCurrentTimeout = timeoutSecs || 0;

    var fill = workflowCard.querySelector(".wfc-timer-fill");
    var text = workflowCard.querySelector(".wfc-timer-text");
    if (!fill || !text) return;

    // Reset fill bar
    fill.style.width = "0%";
    fill.classList.remove("wfc-timer-warn");

    if (workflowCurrentTimeout <= 0) {
        text.textContent = "";
        return;
    }

    function tick() {
        var elapsed = (Date.now() - workflowTimerStart) / 1000;
        var pct = Math.min((elapsed / workflowCurrentTimeout) * 100, 100);
        fill.style.width = pct + "%";
        text.textContent = Math.floor(elapsed) + "s / " + Math.floor(workflowCurrentTimeout) + "s";
        if (pct >= 80) {
            fill.classList.add("wfc-timer-warn");
        } else {
            fill.classList.remove("wfc-timer-warn");
        }
    }

    tick();
    workflowTimerInterval = setInterval(tick, 1000);
}

function updateWorkflowCardDebug(msg) {
    if (!workflowCard) return;
    var dbg = workflowCard.querySelector(".wfc-debug");
    if (!dbg) return;

    var thinkInfo = "";
    if (msg.think_tokens > 0) {
        thinkInfo = " | think:" + msg.think_tokens + "tok(" + (msg.think_detected || "?") + ")";
    }
    var totalSec = (msg.total_ms / 1000).toFixed(1);
    dbg.textContent = msg.step + " \u2014 " + msg.model +
        " | " + msg.eval_tokens + " tok @ " + msg.tok_per_sec + " tok/s" +
        " | out:" + msg.raw_chars + "ch" +
        thinkInfo +
        " | prompt:" + msg.prompt_tokens + " tok" +
        " | " + totalSec + "s";
}

function dismissWorkflowCard() {
    clearInterval(workflowTimerInterval);
    workflowTimerInterval = null;
    if (!workflowCard) return;

    workflowCard.classList.add("wfc-exit");
    var card = workflowCard;
    workflowCard = null;
    setTimeout(function () {
        if (card.parentNode) card.parentNode.removeChild(card);
    }, 500);
}

// --- Workflow narration bubble in chat ---
function showNarrationBubble(text) {
    // Remove previous narration bubble (replace, don't stack)
    var prev = conversationLog.querySelector(".msg-narration");
    if (prev) prev.remove();

    // Also remove thinking/searching indicators
    var thinking = conversationLog.querySelector(".thinking");
    if (thinking) thinking.remove();
    var searching = conversationLog.querySelector(".searching");
    if (searching) searching.remove();

    var el = document.createElement("div");
    el.className = "msg-narration";
    el.textContent = text;
    conversationLog.appendChild(el);
    conversationLog.scrollTop = conversationLog.scrollHeight;
}

// --- Keepalive (backs up server-side WebSocket heartbeat) ---
setInterval(() => { sendMsg("ping"); }, 15000);

// --- Event listeners ---
connectBtn.addEventListener("click", connect);
stopBtn.addEventListener("click", stopSpeaking);

searchToggle.addEventListener("click", () => {
    searchEnabled = !searchEnabled;
    searchToggle.classList.toggle("active", searchEnabled);
    sendMsg("set_search_enabled", { enabled: searchEnabled });
});

debugToggle.addEventListener("click", () => {
    toggleDebugPanels();
});

if (debugBackdrop) {
    debugBackdrop.addEventListener("click", () => {
        hideDebugPanels();
    });
}

providerSelect.addEventListener("change", () => {
    const value = providerSelect.value;
    const colonIdx = value.indexOf(":");
    const provider = colonIdx > -1 ? value.substring(0, colonIdx) : value;
    const model = colonIdx > -1 ? value.substring(colonIdx + 1) : "";

    if (provider === "download") {
        // Trigger download, revert select to previous value
        providerSelect.value = currentSelectValue;
        sendMsg("pull_model", { model: model });
    } else {
        // Switch model
        currentSelectValue = value;
        sendMsg("set_model", { provider: provider, model: model });
    }
});

voiceSelect.addEventListener("change", () => {
    const voiceId = voiceSelect.value;
    if (voiceId && voiceId !== currentVoice) {
        currentVoice = voiceId;
        sendMsg("set_voice", { voice_id: voiceId });
    }
});

tokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connect();
});

// Hold-to-talk: touch events (mobile)
talkBtn.addEventListener("touchstart", (e) => {
    e.preventDefault(); // Prevent long-press menu & ghost clicks
    startTalking();
});
talkBtn.addEventListener("touchend", (e) => {
    e.preventDefault();
    stopTalking();
});
talkBtn.addEventListener("touchcancel", (e) => {
    e.preventDefault();
    stopTalking();
});

// Hold-to-talk: mouse events (desktop fallback)
talkBtn.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // Left click only
    startTalking();
});
talkBtn.addEventListener("mouseup", () => { stopTalking(); });
talkBtn.addEventListener("mouseleave", () => {
    if (isRecording) stopTalking();
});
