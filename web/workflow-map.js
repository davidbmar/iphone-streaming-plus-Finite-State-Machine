"use strict";

/**
 * workflow-map.js — Speaker-workflow-system style FSM graph renderer.
 *
 * Rounded-rect nodes with uppercase IDs, hint text, type badges.
 * Arrow elements with ▼ heads. Teal #00e5cc active glow.
 * Loop children as indented sub-list with branch arms.
 *
 * API:
 *   renderWorkflowGraph(container, workflowDef)
 *   highlightState(stateId, status)
 *   updateLoopChildren(stateId, children, activeIndex)
 *   resetHighlighting()
 *   clearWorkflowGraph()
 */

// Module state
let _container = null;
let _nodeMap = {};       // stateId → DOM element
let _loopNodeMap = {};   // stateId → { container, children[] }

function _clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
}

function renderWorkflowGraph(container, workflowDef) {
    _container = container;
    _nodeMap = {};
    _loopNodeMap = {};
    _clearChildren(container);

    // Workflow title
    var title = document.createElement("div");
    title.className = "wf-title";
    title.textContent = workflowDef.name || workflowDef.workflow_id;
    container.appendChild(title);

    var states = workflowDef.states || [];

    states.forEach(function (state, idx) {
        // Arrow between nodes (except before first)
        if (idx > 0) {
            var arrow = _createArrow("");
            container.appendChild(arrow);
        }

        // State node
        var node = document.createElement("div");
        node.className = "wf-node pending";
        node.dataset.stateId = state.id;

        // Node ID (uppercase)
        var nodeId = document.createElement("div");
        nodeId.className = "node-id";
        nodeId.textContent = state.id.toUpperCase().replace(/_/g, " ");
        node.appendChild(nodeId);

        // Hint text
        var hint = document.createElement("div");
        hint.className = "node-hint";
        hint.textContent = state.name || "";
        node.appendChild(hint);

        // Type badge (top-right pill)
        var badgeText = state.type;
        if (state.type === "llm" && state.has_tool) {
            badgeText = "llm+tool";
        }
        var badge = document.createElement("span");
        badge.className = "wf-type-badge";
        badge.textContent = badgeText;
        node.appendChild(badge);

        // Detail area (for sub-step info, hidden initially)
        var detail = document.createElement("div");
        detail.className = "wf-detail hidden";
        node.appendChild(detail);

        container.appendChild(node);
        _nodeMap[state.id] = node;

        // Loop children container (hidden until populated)
        if (state.type === "loop") {
            var childrenWrap = document.createElement("div");
            childrenWrap.className = "wf-loop-children hidden";
            container.appendChild(childrenWrap);
            _loopNodeMap[state.id] = { container: childrenWrap, children: [] };
        }
    });

    // Exit arrow + node
    var exitArrow = _createArrow("");
    container.appendChild(exitArrow);

    var exitNode = document.createElement("div");
    exitNode.className = "wf-node wf-exit pending";
    exitNode.dataset.stateId = "__exit__";

    var exitId = document.createElement("div");
    exitId.className = "node-id";
    exitId.textContent = "EXIT";
    exitNode.appendChild(exitId);

    var exitHint = document.createElement("div");
    exitHint.className = "node-hint";
    exitHint.textContent = "Done";
    exitNode.appendChild(exitHint);

    container.appendChild(exitNode);
    _nodeMap["__exit__"] = exitNode;
}

function _createArrow(label) {
    var arrow = document.createElement("div");
    arrow.className = "wf-arrow";

    var line = document.createElement("div");
    line.className = "arrow-line";
    arrow.appendChild(line);

    if (label) {
        var labelEl = document.createElement("div");
        labelEl.className = "arrow-label";
        labelEl.textContent = label;
        arrow.appendChild(labelEl);
    }

    var head = document.createElement("div");
    head.className = "arrow-head";
    head.textContent = "\u25BC"; // ▼
    arrow.appendChild(head);

    return arrow;
}

function highlightState(stateId, status, detail) {
    var node = _nodeMap[stateId];
    if (!node) return;

    // Remove previous state classes
    node.classList.remove("pending", "active", "visited", "error");
    node.classList.add(status);

    // Update detail text
    var detailEl = node.querySelector(".wf-detail");
    if (detailEl) {
        detailEl.textContent = detail || "";
        if (detail) {
            detailEl.classList.remove("hidden");
        } else {
            detailEl.classList.add("hidden");
        }
    }

    // Scroll active node into view
    if (status === "active") {
        node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
}

function updateLoopChildren(stateId, children, activeIndex) {
    var loopData = _loopNodeMap[stateId];
    if (!loopData) return;

    var wrap = loopData.container;
    _clearChildren(wrap);
    wrap.classList.remove("hidden");
    loopData.children = [];

    children.forEach(function (queryText, idx) {
        var branch = document.createElement("div");
        branch.className = "wf-branch";

        var arm = document.createElement("div");
        arm.className = "wf-branch-arm";
        branch.appendChild(arm);

        var childNode = document.createElement("div");
        childNode.className = "wf-child-node";
        if (idx === activeIndex) {
            childNode.classList.add("active");
        } else if (idx < activeIndex) {
            childNode.classList.add("visited");
        }

        // Status indicator
        var indicator = document.createElement("span");
        indicator.className = "wf-child-indicator";
        if (idx === activeIndex) {
            indicator.textContent = "\u25CF"; // ●
        } else if (idx < activeIndex) {
            indicator.textContent = "\u25C9"; // ◉
        } else {
            indicator.textContent = "\u25CB"; // ○
        }
        childNode.appendChild(indicator);

        var childLabel = document.createElement("span");
        childLabel.className = "wf-child-label";
        childLabel.textContent = queryText.length > 35
            ? queryText.substring(0, 32) + "..."
            : queryText;
        childLabel.title = queryText;
        childNode.appendChild(childLabel);

        branch.appendChild(childNode);
        wrap.appendChild(branch);
        loopData.children.push(childNode);
    });
}

function resetHighlighting() {
    Object.keys(_nodeMap).forEach(function (id) {
        highlightState(id, "pending", "");
    });
    Object.keys(_loopNodeMap).forEach(function (id) {
        _loopNodeMap[id].container.classList.add("hidden");
        _clearChildren(_loopNodeMap[id].container);
    });
}

function clearWorkflowGraph() {
    if (_container) {
        _clearChildren(_container);
    }
    _nodeMap = {};
    _loopNodeMap = {};
}

// Export to global scope (vanilla JS, no module bundler)
window.WorkflowMap = {
    render: renderWorkflowGraph,
    highlight: highlightState,
    updateLoop: updateLoopChildren,
    reset: resetHighlighting,
    clear: clearWorkflowGraph,
};
