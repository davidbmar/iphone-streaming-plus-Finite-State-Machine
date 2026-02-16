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

// --- Chat bubble helpers ---
function addChatBubble(text, role) {
    const thinking = conversationLog.querySelector(".thinking");
    if (thinking) thinking.remove();

    const bubble = document.createElement("div");
    bubble.className = "msg msg-" + role;
    bubble.textContent = text;
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

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        setStatus("Authenticating...");
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
    };

    ws.onclose = () => {
        if (!agentScreen.classList.contains("hidden")) {
            agentScreen.classList.add("hidden");
            connectScreen.classList.remove("hidden");
        }
        setStatus("Disconnected", true);
        connectBtn.disabled = false;
        cleanupWebRTC();
    };
}

function setStatus(text, isError) {
    connectStatus.textContent = text;
    connectStatus.className = "connect-status" + (isError ? " error" : "");
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
            addChatBubble(msg.text, "agent");
            setAgentSpeaking(true);
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

    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        setStatus("Mic access denied", true);
        connectBtn.disabled = false;
        return;
    }

    setStatus("Connecting audio...");

    try {
    const config = { iceServers: iceServers.length > 0 ? iceServers : undefined };
    pc = new RTCPeerConnection(config);

    const micTrack = micStream.getAudioTracks()[0];
    pc.addTrack(micTrack, micStream);

    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log("ICE state:", state);
        if (state === "connected" || state === "completed") {
            connectScreen.classList.add("hidden");
            agentScreen.classList.remove("hidden");
            talkBtn.disabled = false;

            if (audioEl) {
                audioEl.play().catch(() => {});
            }
        } else if (state === "failed") {
            setStatus("Audio connection failed — check network", true);
            connectBtn.disabled = false;
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
