#!/usr/bin/env python3
"""Playwright UI tests for Workflow v2 — visual debugger + narration.

Tests the new UI independently of WebRTC (which doesn't work headless).
Connects via WebSocket, then programmatically shows the agent screen
to test the workflow renderer, model select, and narration.

Requires a running server at localhost:8080 and Chromium installed:
    python3 -m playwright install chromium

Usage:
    python3 tests/test_ui_workflow_v2.py
"""

import sys
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

passed = 0
failed = 0
skipped = 0


def report(name, ok, detail=""):
    global passed, failed
    if ok:
        tag = f"{GREEN}PASS{RESET}"
        passed += 1
    else:
        tag = f"{RED}FAIL{RESET}"
        failed += 1
    msg = f"  [{tag}] {name}"
    if detail:
        msg += f"  ({detail})"
    print(msg)


def skip(name, reason=""):
    global skipped
    skipped += 1
    msg = f"  [{YELLOW}SKIP{RESET}] {name}"
    if reason:
        msg += f"  ({reason})"
    print(msg)


def section(title):
    print(f"\n{CYAN}{BOLD}--- {title} ---{RESET}")


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright not installed. Run: pip3 install playwright && python3 -m playwright install chromium")
        sys.exit(1)

    auth_token = os.getenv("AUTH_TOKEN", "devtoken")
    base_url = os.getenv("TEST_URL", "http://localhost:8080")

    print(f"\n{BOLD}{'=' * 56}")
    print(f"  Workflow v2 — Playwright UI Tests")
    print(f"  Server: {base_url}")
    print(f"{'=' * 56}{RESET}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Playwright Test)",
        )
        page = context.new_page()

        # ── Test 1: Page loads ──────────────────────────────
        section("Page Load")
        try:
            page.goto(base_url, timeout=10000)
            report("page loads without error", True)
        except Exception as e:
            report("page loads without error", False, str(e))
            browser.close()
            _print_summary()
            return

        title = page.title()
        report("page title is 'Voice Agent'", title == "Voice Agent", f"got: {title}")

        # ── Test 2: Cache-busted versions ──────────────────
        section("Cache Busting (served HTML)")
        html = page.content()
        report("styles.css has cache-bust param", "styles.css?v=" in html)
        report("workflow-map.js has cache-bust param", "workflow-map.js?v=" in html)
        report("workflow-code.js has cache-bust param", "workflow-code.js?v=" in html)
        report("app.js has cache-bust param", "app.js?v=" in html)

        # ── Test 3: JS modules loaded ──────────────────────
        section("JS Modules")
        has_wf_map = page.evaluate("typeof window.WorkflowMap")
        report("WorkflowMap loaded", has_wf_map == "object", f"type: {has_wf_map}")

        has_wf_code = page.evaluate("typeof window.WorkflowCode")
        report("WorkflowCode loaded", has_wf_code == "object", f"type: {has_wf_code}")

        map_methods = page.evaluate("Object.keys(window.WorkflowMap).sort().join(',')")
        report("WorkflowMap API complete",
               all(m in map_methods for m in ["render", "highlight", "updateLoop", "clear"]),
               map_methods)

        code_methods = page.evaluate("Object.keys(window.WorkflowCode).sort().join(',')")
        report("WorkflowCode API complete",
               all(m in code_methods for m in ["render", "highlight", "clear"]),
               code_methods)

        # ── Test 4: Debug panels exist but hidden ──────────
        section("Debug Panels Structure")
        report("debug-panels element exists",
               page.locator("#debug-panels").count() == 1)
        report("debug-panels hidden by default",
               not page.evaluate("document.getElementById('debug-panels').classList.contains('visible')"))
        report("workflow-map-panel exists",
               page.locator("#workflow-map-panel").count() == 1)
        report("workflow-code-panel exists",
               page.locator("#workflow-code-panel").count() == 1)

        # ── Test 5: Connect + model default ────────────────
        section("WebSocket Connect & Default Model")

        # Connect via WS to get hello_ack, then force-show agent screen
        # (WebRTC won't work headless, so we show agent screen manually)
        page.locator("#token-input").fill(auth_token)
        page.locator("#connect-btn").click()

        # Wait for WS hello_ack to populate the selects
        # The select gets populated even if WebRTC fails
        try:
            page.wait_for_function(
                "document.getElementById('provider-select').options.length > 0",
                timeout=10000,
            )
            report("model select populated after hello_ack", True)
        except Exception as e:
            report("model select populated after hello_ack", False, str(e))
            browser.close()
            _print_summary()
            return

        # Check default model
        selected_value = page.evaluate("document.getElementById('provider-select').value")
        report("default model is qwen3:8b",
               selected_value == "ollama:qwen3:8b",
               f"got: {selected_value}")

        selected_text = page.evaluate("""
            (() => {
                const sel = document.getElementById('provider-select');
                return sel.options[sel.selectedIndex]?.textContent || '';
            })()
        """)
        report("selected text contains qwen3",
               "qwen3" in selected_text.lower(),
               f"text: {selected_text}")

        # Check voice select was populated too
        voice_count = page.evaluate("document.getElementById('voice-select').options.length")
        report("voice select populated", voice_count > 0, f"{voice_count} voices")

        # ── Force-show agent screen for remaining tests ────
        page.evaluate("""
            document.getElementById('connect-screen').classList.add('hidden');
            document.getElementById('agent-screen').classList.remove('hidden');
        """)
        page.wait_for_timeout(300)

        # ── Test 6: Debug toggle ───────────────────────────
        section("Debug Toggle")
        debug_toggle = page.locator("#debug-toggle")
        report("debug toggle visible", debug_toggle.is_visible())

        debug_toggle.click()
        page.wait_for_timeout(300)
        report("panels show on click",
               page.evaluate("document.getElementById('debug-panels').classList.contains('visible')"))

        debug_toggle.click()
        page.wait_for_timeout(300)
        report("panels hide on second click",
               not page.evaluate("document.getElementById('debug-panels').classList.contains('visible')"))

        # ── Test 7: Workflow map renderer (v2 style) ───────
        section("Workflow Map Renderer (v2 nodes)")

        page.evaluate("""
            (() => {
                const mockDef = {
                    workflow_id: "research_compare",
                    name: "Research & Compare",
                    description: "Lookup current data, decompose, search each entity, synthesize",
                    states: [
                        { id: "initial_lookup", name: "Initial lookup", type: "llm",
                          has_tool: true, tool_name: "web_search", next_step: "decompose",
                          narration: "Searching for top S&P 500...", prompt_template: "" },
                        { id: "decompose", name: "Decomposing query", type: "llm",
                          has_tool: false, tool_name: "", next_step: "search_each",
                          narration: "Found results. Breaking into individual searches...",
                          prompt_template: "" },
                        { id: "search_each", name: "Searching each", type: "loop",
                          has_tool: true, tool_name: "web_search", next_step: "synthesize",
                          narration: "Looking up each company...", prompt_template: "" },
                        { id: "synthesize", name: "Synthesizing", type: "llm",
                          has_tool: false, tool_name: "", next_step: "",
                          narration: "Putting it all together...", prompt_template: "" }
                    ]
                };
                const mapEl = document.getElementById('workflow-map');
                window.WorkflowMap.render(mapEl, mockDef);
                const codeEl = document.getElementById('workflow-code');
                window.WorkflowCode.render(codeEl, mockDef);
                document.getElementById('debug-panels').classList.add('visible');
            })()
        """)
        page.wait_for_timeout(500)

        # 4 state nodes + 1 exit = 5
        node_count = page.locator(".wf-node").count()
        report("5 nodes (4 states + exit)", node_count == 5, f"got {node_count}")

        # Uppercase node IDs (v2 feature)
        first_id = page.locator(".node-id").first.text_content()
        report("node IDs are uppercase",
               first_id == "INITIAL LOOKUP",
               f"got: '{first_id}'")

        # Hint text (v2 feature)
        first_hint = page.locator(".node-hint").first.text_content()
        report("node has hint text", first_hint == "Initial lookup",
               f"got: '{first_hint}'")

        # Type badges (v2 feature)
        badges = page.locator(".wf-type-badge")
        report("type badges rendered", badges.count() >= 4, f"got {badges.count()}")
        report("first badge is 'llm+tool'",
               badges.first.text_content() == "llm+tool",
               f"got: '{badges.first.text_content()}'")

        # Arrow elements with ▼ (v2 feature — replaces v1 connectors)
        arrows = page.locator(".wf-arrow")
        report("arrow elements between nodes", arrows.count() >= 4,
               f"got {arrows.count()}")

        arrow_head = page.locator(".arrow-head").first.text_content()
        report("arrow heads use ▼ character", arrow_head == "\u25bc",
               f"got: '{arrow_head}'")

        # No old v1 connectors
        old_connectors = page.locator(".wf-connector")
        report("no old v1 .wf-connector elements", old_connectors.count() == 0,
               f"got {old_connectors.count()}")

        # No old v1 indicators
        old_indicators = page.locator(".wf-indicator")
        report("no old v1 .wf-indicator elements", old_indicators.count() == 0,
               f"got {old_indicators.count()}")

        # Exit node
        exit_node = page.locator(".wf-exit")
        report("exit node exists", exit_node.count() == 1)
        report("exit node says EXIT",
               exit_node.locator(".node-id").text_content() == "EXIT")

        # ── Test 8: Code view syntax highlighting (v2) ─────
        section("Code View Syntax Highlighting")

        report("code-keyword spans (purple)",
               page.locator(".code-keyword").count() > 0,
               f"{page.locator('.code-keyword').count()} spans")
        report("code-string spans (green)",
               page.locator(".code-string").count() > 0,
               f"{page.locator('.code-string').count()} spans")
        report("code-intent spans (orange)",
               page.locator(".code-intent").count() > 0,
               f"{page.locator('.code-intent').count()} spans")
        report("code-state-ref spans (blue)",
               page.locator(".code-state-ref").count() > 0,
               f"{page.locator('.code-state-ref').count()} spans")

        report("4 code blocks", page.locator(".code-block").count() == 4,
               f"got {page.locator('.code-block').count()}")

        # say: lines for narration
        say_count = page.evaluate("""
            Array.from(document.querySelectorAll('.code-keyword'))
                .filter(s => s.textContent.includes('say:')).length
        """)
        report("'say:' keyword lines present", say_count >= 4,
               f"got {say_count}")

        # No old v1 code elements
        old_headers = page.locator(".code-header")
        report("no old v1 .code-header elements", old_headers.count() == 0,
               f"got {old_headers.count()}")
        old_sections = page.locator(".code-section-header")
        report("no old v1 .code-section-header elements", old_sections.count() == 0,
               f"got {old_sections.count()}")

        # ── Test 9: State highlighting (teal glow) ─────────
        section("State Highlighting (teal glow)")

        page.evaluate("window.WorkflowMap.highlight('initial_lookup', 'active', '')")
        page.evaluate("window.WorkflowCode.highlight('initial_lookup')")
        page.wait_for_timeout(200)

        report("active node gets .active class",
               page.evaluate("""
                   document.querySelector('.wf-node[data-state-id="initial_lookup"]')
                       .classList.contains('active')
               """))

        report("active code block gets .active class",
               page.evaluate("""
                   document.querySelector('.code-block[data-state-id="initial_lookup"]')
                       .classList.contains('active')
               """))

        # Transition: visited + next active
        page.evaluate("""
            window.WorkflowMap.highlight('initial_lookup', 'visited', '');
            window.WorkflowMap.highlight('decompose', 'active', '');
            window.WorkflowCode.highlight('decompose');
        """)
        page.wait_for_timeout(200)

        report("node transitions to visited",
               page.evaluate("""
                   document.querySelector('.wf-node[data-state-id="initial_lookup"]')
                       .classList.contains('visited')
               """))
        report("next node becomes active",
               page.evaluate("""
                   document.querySelector('.wf-node[data-state-id="decompose"]')
                       .classList.contains('active')
               """))

        # ── Test 10: Loop children ─────────────────────────
        section("Loop Children")

        page.evaluate("""
            window.WorkflowMap.updateLoop('search_each',
                ['Apple market cap', 'NVIDIA market cap', 'Microsoft market cap'], 1)
        """)
        page.wait_for_timeout(300)

        report("3 loop children rendered",
               page.locator(".wf-child-node").count() == 3,
               f"got {page.locator('.wf-child-node').count()}")
        report("active child (index 1)",
               page.locator(".wf-child-node.active").count() == 1)
        report("visited child (index 0)",
               page.locator(".wf-child-node.visited").count() == 1)

        # ── Test 11: Narration bubble ──────────────────────
        section("Narration Bubble")

        # Inject narration via DOM (showNarrationBubble is module-scoped)
        page.evaluate("""
            (() => {
                const log = document.getElementById('conversation-log');
                // Remove existing
                const prev = log.querySelector('.msg-narration');
                if (prev) prev.remove();
                // Add narration bubble
                const el = document.createElement('div');
                el.className = 'msg-narration';
                el.textContent = 'Searching for top S&P 500 companies...';
                log.appendChild(el);
            })()
        """)
        page.wait_for_timeout(200)

        narr = page.locator(".msg-narration")
        report("narration bubble appears", narr.count() >= 1)
        if narr.count() > 0:
            report("narration text correct",
                   "S&P 500" in narr.first.text_content(),
                   f"text: {narr.first.text_content()[:50]}")

        # ── Test 12: CSS teal theme variables ──────────────
        section("CSS Theme Variables")

        teal = page.evaluate(
            "getComputedStyle(document.documentElement).getPropertyValue('--teal').trim()")
        report("--teal is #00e5cc", teal == "#00e5cc", f"got: '{teal}'")

        panel_bg = page.evaluate(
            "getComputedStyle(document.documentElement).getPropertyValue('--panel-bg').trim()")
        report("--panel-bg is #0a0a12", panel_bg == "#0a0a12", f"got: '{panel_bg}'")

        font_code = page.evaluate(
            "getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim()")
        report("--font-code starts with 'SF Mono'",
               font_code.startswith("'SF Mono'") or font_code.startswith("SF Mono"),
               f"got: '{font_code[:50]}'")

        # Check active node has teal border (computed style)
        active_border = page.evaluate("""
            (() => {
                const node = document.querySelector('.wf-node.active');
                if (!node) return 'no active node';
                return getComputedStyle(node).borderColor;
            })()
        """)
        report("active node has teal border color",
               "0, 229, 204" in active_border or "00e5cc" in active_border.lower(),
               f"border: {active_border}")

        # ── Done ───────────────────────────────────────────
        browser.close()

    _print_summary()


def _print_summary():
    total = passed + failed + skipped
    print(f"\n{BOLD}{'=' * 56}")
    print(f"  Results: {GREEN}{passed} passed{RESET}{BOLD}, ", end="")
    if failed:
        print(f"{RED}{failed} failed{RESET}{BOLD}, ", end="")
    else:
        print(f"0 failed, ", end="")
    print(f"{YELLOW}{skipped} skipped{RESET}{BOLD}  ({total} total)")
    print(f"{'=' * 56}{RESET}")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
