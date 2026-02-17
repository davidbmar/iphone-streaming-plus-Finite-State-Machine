"use strict";

/**
 * workflow-code.js — Syntax-highlighted pseudocode view for the visual debugger.
 *
 * Four-color scheme matching speaker-workflow-system:
 *   .code-keyword  — purple #cc88ff: workflow, state, type:, say:, tool:, →
 *   .code-string   — green #44cc88: quoted strings (narration, prompts)
 *   .code-intent   — orange #ffaa44: step type values (llm, loop, direct)
 *   .code-state-ref — blue #4a9eff: state ID references
 *
 * Active state gets teal left-border + teal-tinted background.
 *
 * API:
 *   renderWorkflowCode(container, workflowDef)
 *   highlightCodeBlock(stateId)
 *   clearWorkflowCode()
 */

let _codeContainer = null;
let _blockMap = {};  // stateId → DOM element

function _clearEl(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
}

function _span(cls, text) {
    var s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
}

function _codeLine(indent) {
    var line = document.createElement("div");
    line.className = "code-line";
    if (indent) {
        line.style.paddingLeft = (indent * 12) + "px";
    }
    return line;
}

function renderWorkflowCode(container, workflowDef) {
    _codeContainer = container;
    _blockMap = {};
    _clearEl(container);

    // Header: workflow "name"
    var headerLine = _codeLine(0);
    headerLine.appendChild(_span("code-keyword", "workflow "));
    headerLine.appendChild(_span("code-string", '"' + (workflowDef.workflow_id || "unknown") + '"'));
    container.appendChild(headerLine);

    // Trigger keywords (if available from description)
    if (workflowDef.description) {
        var trigLine = _codeLine(1);
        trigLine.appendChild(_span("code-keyword", "desc: "));
        trigLine.appendChild(_span("code-string", '"' + workflowDef.description + '"'));
        container.appendChild(trigLine);
    }

    // Blank line
    container.appendChild(_codeLine(0));

    // States
    var states = workflowDef.states || [];
    states.forEach(function (state, idx) {
        var block = document.createElement("div");
        block.className = "code-block";
        block.dataset.stateId = state.id;

        // state STATE_NAME
        var nameLine = _codeLine(0);
        nameLine.appendChild(_span("code-keyword", "state "));
        nameLine.appendChild(_span("code-state-ref", state.id.toUpperCase()));
        block.appendChild(nameLine);

        // type: llm
        var typeLine = _codeLine(1);
        typeLine.appendChild(_span("code-keyword", "type: "));
        var typeText = state.type;
        if (state.type === "llm" && state.has_tool) {
            typeText = "llm+tool";
        }
        typeLine.appendChild(_span("code-intent", typeText));
        block.appendChild(typeLine);

        // say: "narration..." (if present)
        if (state.narration) {
            var sayLine = _codeLine(1);
            sayLine.appendChild(_span("code-keyword", "say: "));
            sayLine.appendChild(_span("code-string", '"' + state.narration + '"'));
            block.appendChild(sayLine);
        }

        // tool: web_search (if present)
        if (state.has_tool && state.tool_name) {
            var toolLine = _codeLine(1);
            toolLine.appendChild(_span("code-keyword", "tool: "));
            toolLine.appendChild(_span("code-intent", state.tool_name));
            block.appendChild(toolLine);
        }

        // → NEXT_STATE or → EXIT
        var arrowLine = _codeLine(1);
        arrowLine.appendChild(_span("code-keyword", "\u2192 "));
        if (state.next_step) {
            arrowLine.appendChild(_span("code-state-ref", state.next_step.toUpperCase()));
        } else {
            arrowLine.appendChild(_span("code-state-ref", "EXIT"));
        }
        block.appendChild(arrowLine);

        // Click handler: bidirectional linking with graph
        block.addEventListener("click", function () {
            var sid = this.dataset.stateId;
            var graphNode = document.querySelector(
                '.wf-node[data-state-id="' + sid + '"]'
            );
            if (graphNode) {
                graphNode.classList.add("flash");
                setTimeout(function () { graphNode.classList.remove("flash"); }, 600);
            }
        });

        container.appendChild(block);
        _blockMap[state.id] = block;
    });
}

function highlightCodeBlock(stateId) {
    // Remove active from all blocks
    Object.keys(_blockMap).forEach(function (id) {
        _blockMap[id].classList.remove("active");
    });

    // Add active to target
    var block = _blockMap[stateId];
    if (block) {
        block.classList.add("active");
        block.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
}

function clearWorkflowCode() {
    if (_codeContainer) {
        _clearEl(_codeContainer);
    }
    _blockMap = {};
}

// Export to global scope
window.WorkflowCode = {
    render: renderWorkflowCode,
    highlight: highlightCodeBlock,
    clear: clearWorkflowCode,
};
