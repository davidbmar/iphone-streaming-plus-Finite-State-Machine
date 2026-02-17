#!/usr/bin/env python3
"""Playwright mobile viewport tests — iPhone Safari simulation.

Verifies mobile layout, touch targets, Safari workarounds, and
debug panel behavior at narrow viewport widths.

Requires a running server at localhost:8080 and Chromium installed:
    python3 -m playwright install chromium

Usage:
    python3 tests/test_mobile_ui.py
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


# iPhone 14 viewport (390x844) with Safari user agent
IPHONE_VIEWPORT = {"width": 390, "height": 844}
SAFARI_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.0 Mobile/15E148 Safari/604.1"
)


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright not installed. Run: pip3 install playwright && python3 -m playwright install chromium")
        sys.exit(1)

    auth_token = os.getenv("AUTH_TOKEN", "devtoken")
    base_url = os.getenv("TEST_URL", "http://localhost:8080")

    print(f"\n{BOLD}{'=' * 56}")
    print(f"  Mobile UI — Playwright iPhone Viewport Tests")
    print(f"  Server: {base_url}")
    print(f"  Viewport: {IPHONE_VIEWPORT['width']}x{IPHONE_VIEWPORT['height']}")
    print(f"{'=' * 56}{RESET}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport=IPHONE_VIEWPORT,
            user_agent=SAFARI_UA,
            has_touch=True,
            is_mobile=True,
            device_scale_factor=3,  # iPhone 14 = 3x
        )
        page = context.new_page()

        # ══════════════════════════════════════════════
        # Section 1: Viewport & Meta Tags
        # ══════════════════════════════════════════════
        section("Viewport & Meta Tags")
        try:
            page.goto(base_url, timeout=10000)
            report("page loads at mobile viewport", True)
        except Exception as e:
            report("page loads at mobile viewport", False, str(e))
            browser.close()
            _print_summary()
            return

        # Check viewport meta tag
        viewport_meta = page.evaluate("""
            (() => {
                const meta = document.querySelector('meta[name="viewport"]');
                return meta ? meta.getAttribute('content') : '';
            })()
        """)
        report("viewport meta tag exists", bool(viewport_meta), f"content: {viewport_meta}")
        report("user-scalable=no set",
               "user-scalable=no" in viewport_meta,
               f"content: {viewport_meta}")
        report("width=device-width set",
               "device-width" in viewport_meta,
               f"content: {viewport_meta}")

        # ══════════════════════════════════════════════
        # Section 2: Safe Area CSS
        # ══════════════════════════════════════════════
        section("Safe Area CSS Properties")

        # Check that env(safe-area-inset-*) is used in critical areas
        # We check the computed padding values — env() resolves to 0 in non-notched contexts
        top_bar_padding_top = page.evaluate("""
            getComputedStyle(document.getElementById('top-bar')).paddingTop
        """)
        report("top-bar has padding-top (safe-area aware)",
               top_bar_padding_top and top_bar_padding_top != "0px",
               f"padding-top: {top_bar_padding_top}")

        bottom_bar_padding_bottom = page.evaluate("""
            getComputedStyle(document.getElementById('bottom-bar')).paddingBottom
        """)
        report("bottom-bar has padding-bottom (safe-area aware)",
               bottom_bar_padding_bottom and bottom_bar_padding_bottom != "0px",
               f"padding-bottom: {bottom_bar_padding_bottom}")

        # Check that safe-area env() appears in the stylesheet
        has_safe_area_top = page.evaluate("""
            (() => {
                for (const sheet of document.styleSheets) {
                    try {
                        for (const rule of sheet.cssRules) {
                            if (rule.cssText && rule.cssText.includes('safe-area-inset'))
                                return true;
                        }
                    } catch(e) {}
                }
                return false;
            })()
        """)
        report("CSS uses env(safe-area-inset-*)", has_safe_area_top)

        # ══════════════════════════════════════════════
        # Section 3: Touch Target Sizing
        # ══════════════════════════════════════════════
        section("Touch Target Sizing (min 44x44)")

        # All buttons should be at least 44px in height for mobile touch
        buttons_too_small = page.evaluate("""
            (() => {
                const buttons = document.querySelectorAll('button');
                const small = [];
                for (const btn of buttons) {
                    if (btn.offsetParent === null) continue;
                    const rect = btn.getBoundingClientRect();
                    if (rect.height < 44 || rect.width < 44) {
                        small.push({
                            id: btn.id || btn.className,
                            w: Math.round(rect.width),
                            h: Math.round(rect.height)
                        });
                    }
                }
                return small;
            })()
        """)
        report("all visible buttons >= 44px touch target",
               len(buttons_too_small) == 0,
               f"too small: {buttons_too_small}" if buttons_too_small else "all OK")

        # Token input should be at least 44px
        input_height = page.evaluate("""
            document.getElementById('token-input').getBoundingClientRect().height
        """)
        report("token input >= 44px height",
               input_height >= 44,
               f"height: {input_height}px")

        # ══════════════════════════════════════════════
        # Section 4: Container Width
        # ══════════════════════════════════════════════
        section("Container Fits Mobile Width")

        container_width = page.evaluate("""
            document.querySelector('.container').getBoundingClientRect().width
        """)
        report("container <= viewport width",
               container_width <= IPHONE_VIEWPORT["width"],
               f"container: {container_width}px, viewport: {IPHONE_VIEWPORT['width']}px")

        # Check no horizontal scrollbar
        has_h_scroll = page.evaluate("""
            document.documentElement.scrollWidth > document.documentElement.clientWidth
        """)
        report("no horizontal scroll overflow", not has_h_scroll)

        # ══════════════════════════════════════════════
        # Section 5: WebSocket Connect & Force Agent Screen
        # ══════════════════════════════════════════════
        section("WebSocket Connect (mobile)")
        page.locator("#token-input").fill(auth_token)
        page.locator("#connect-btn").click()

        try:
            page.wait_for_function(
                "document.getElementById('provider-select').options.length > 0",
                timeout=10000,
            )
            report("model select populated on mobile", True)
        except Exception as e:
            report("model select populated on mobile", False, str(e))
            browser.close()
            _print_summary()
            return

        # Force-show agent screen (WebRTC won't work headless)
        page.evaluate("""
            document.getElementById('connect-screen').classList.add('hidden');
            document.getElementById('agent-screen').classList.remove('hidden');
        """)
        page.wait_for_timeout(300)

        # ══════════════════════════════════════════════
        # Section 6: Debug Panels — Slide-Over on Mobile
        # ══════════════════════════════════════════════
        section("Debug Panels (mobile slide-over)")

        # At 390px wide, debug panels should use position:fixed overlay, not side-by-side
        page.locator("#debug-toggle").click()
        page.wait_for_timeout(300)

        debug_visible = page.evaluate(
            "document.getElementById('debug-panels').classList.contains('visible')")
        report("debug panels show on mobile", debug_visible)

        debug_position = page.evaluate("""
            getComputedStyle(document.getElementById('debug-panels')).position
        """)
        report("debug panels are position:fixed (slide-over)",
               debug_position == "fixed",
               f"position: {debug_position}")

        debug_width = page.evaluate("""
            document.getElementById('debug-panels').getBoundingClientRect().width
        """)
        max_panel_width = IPHONE_VIEWPORT["width"] * 0.85
        report(f"debug panel width ~85vw (max {max_panel_width}px)",
               debug_width <= max_panel_width + 2,  # small tolerance
               f"width: {debug_width}px")

        # Panels should be stacked vertically on mobile (flex-direction: column)
        panel_flex_dir = page.evaluate("""
            getComputedStyle(document.getElementById('debug-panels')).flexDirection
        """)
        report("debug panels stacked vertically on mobile",
               panel_flex_dir == "column",
               f"flex-direction: {panel_flex_dir}")

        # Close debug panels via backdrop click (tests the mobile dismiss mechanism)
        backdrop = page.locator("#debug-backdrop")
        backdrop_exists = backdrop.count() > 0
        report("debug backdrop element exists", backdrop_exists)
        if backdrop_exists:
            backdrop_visible = page.evaluate(
                "document.getElementById('debug-backdrop').classList.contains('visible')")
            report("backdrop visible when panels open", backdrop_visible)
            # Click the exposed right margin (panels are 85vw, backdrop is full screen)
            # At 390px viewport, panels are ~332px wide, so x=370 is in the exposed area
            page.mouse.click(370, 400)
            page.wait_for_timeout(300)
            panels_closed = not page.evaluate(
                "document.getElementById('debug-panels').classList.contains('visible')")
            report("backdrop click closes panels", panels_closed)
        else:
            # Fallback: close via JS
            page.evaluate("""
                document.getElementById('debug-panels').classList.remove('visible');
            """)
            page.wait_for_timeout(200)

        # ══════════════════════════════════════════════
        # Section 7: Narration Bubble on Mobile
        # ══════════════════════════════════════════════
        section("Narration Bubble (mobile width)")

        page.evaluate("""
            (() => {
                const log = document.getElementById('conversation-log');
                const el = document.createElement('div');
                el.className = 'msg-narration';
                el.textContent = 'Searching for the top performing S&P 500 companies by market cap...';
                log.appendChild(el);
            })()
        """)
        page.wait_for_timeout(200)

        narr = page.locator(".msg-narration")
        report("narration bubble renders", narr.count() >= 1)
        if narr.count() > 0:
            narr_width = page.evaluate("""
                document.querySelector('.msg-narration').getBoundingClientRect().width
            """)
            conv_width = page.evaluate("""
                document.getElementById('conversation-log').getBoundingClientRect().width
            """)
            report("narration fits within chat area",
                   narr_width <= conv_width,
                   f"narration: {narr_width:.0f}px, chat: {conv_width:.0f}px")

        # ══════════════════════════════════════════════
        # Section 8: Workflow Activity Card on Mobile
        # ══════════════════════════════════════════════
        section("Workflow Activity Card (mobile)")

        # Render workflow graph (needed for WorkflowMap/Code)
        page.evaluate("""
            (() => {
                const mockDef = {
                    workflow_id: "research_compare",
                    name: "Research & Compare",
                    states: [
                        { id: "initial_lookup", name: "Initial lookup", type: "llm",
                          has_tool: true, tool_name: "web_search", next_step: "decompose",
                          narration: "Searching...", prompt_template: "" },
                        { id: "decompose", name: "Decomposing", type: "llm",
                          has_tool: false, tool_name: "", next_step: "search_each",
                          narration: "Breaking down...", prompt_template: "" },
                        { id: "search_each", name: "Searching each", type: "loop",
                          has_tool: true, tool_name: "web_search", next_step: "synthesize",
                          narration: "Looking up...", prompt_template: "" },
                        { id: "synthesize", name: "Synthesizing", type: "llm",
                          has_tool: false, tool_name: "", next_step: "",
                          narration: "Putting together...", prompt_template: "" }
                    ]
                };
                const mapEl = document.getElementById('workflow-map');
                window.WorkflowMap.render(mapEl, mockDef);
                const codeEl = document.getElementById('workflow-code');
                window.WorkflowCode.render(codeEl, mockDef);
            })()
        """)
        page.wait_for_timeout(200)

        # Build workflow card using safe DOM methods
        page.evaluate("""
            (() => {
                const log = document.getElementById('conversation-log');
                const card = document.createElement('div');
                card.className = 'workflow-card';

                const header = document.createElement('div');
                header.className = 'wfc-header';
                header.textContent = 'RESEARCH & COMPARE';
                card.appendChild(header);

                const progress = document.createElement('div');
                progress.className = 'wfc-progress';
                for (let i = 0; i < 4; i++) {
                    const seg = document.createElement('div');
                    seg.className = 'wfc-segment' + (i === 0 ? ' active' : '');
                    progress.appendChild(seg);
                }
                card.appendChild(progress);

                const stepLabel = document.createElement('div');
                stepLabel.className = 'wfc-step-label';
                stepLabel.textContent = 'Step 1 of 4 \\u2014 INITIAL LOOKUP';
                card.appendChild(stepLabel);

                const activity = document.createElement('div');
                activity.className = 'wfc-activity';
                activity.textContent = 'Searching for top S&P 500 companies...';
                card.appendChild(activity);

                const timerRow = document.createElement('div');
                timerRow.className = 'wfc-timer-row';
                const timerTrack = document.createElement('div');
                timerTrack.className = 'wfc-timer-track';
                const timerFill = document.createElement('div');
                timerFill.className = 'wfc-timer-fill';
                timerFill.style.width = '30%';
                timerTrack.appendChild(timerFill);
                const timerText = document.createElement('div');
                timerText.className = 'wfc-timer-text';
                timerText.textContent = '3s / 10s';
                timerRow.appendChild(timerTrack);
                timerRow.appendChild(timerText);
                card.appendChild(timerRow);

                const debugRow = document.createElement('div');
                debugRow.className = 'wfc-debug';
                debugRow.textContent = 'initial_lookup \\u2014 ollama:qwen3:8b | 42 tok @ 31.5 tok/s';
                card.appendChild(debugRow);

                log.appendChild(card);
            })()
        """)
        page.wait_for_timeout(200)

        wf_card = page.locator(".workflow-card")
        report("workflow card renders", wf_card.count() >= 1)
        if wf_card.count() > 0:
            card_width = page.evaluate("""
                document.querySelector('.workflow-card').getBoundingClientRect().width
            """)
            conv_width = page.evaluate("""
                document.getElementById('conversation-log').getBoundingClientRect().width
            """)
            report("workflow card fits within chat area",
                   card_width <= conv_width,
                   f"card: {card_width:.0f}px, chat: {conv_width:.0f}px")

            # Check debug text has text-overflow ellipsis CSS
            debug_overflow_css = page.evaluate("""
                getComputedStyle(document.querySelector('.wfc-debug')).textOverflow
            """)
            report("debug text has text-overflow:ellipsis",
                   debug_overflow_css == "ellipsis",
                   f"text-overflow: {debug_overflow_css}")

        # ══════════════════════════════════════════════
        # Section 9: Chat Bubbles on Mobile
        # ══════════════════════════════════════════════
        section("Chat Bubbles (mobile width)")

        page.evaluate("""
            (() => {
                const log = document.getElementById('conversation-log');
                const user = document.createElement('div');
                user.className = 'msg msg-user';
                user.textContent = 'What are the top 5 companies in the S&P 500 by market cap?';
                log.appendChild(user);
                const agent = document.createElement('div');
                agent.className = 'msg msg-agent';
                agent.textContent = 'Here are the top 5 S&P 500 companies by market capitalization as of today. Apple leads with approximately $3.5 trillion, followed by Microsoft, NVIDIA, Amazon, and Alphabet.';
                log.appendChild(agent);
            })()
        """)
        page.wait_for_timeout(200)

        user_bubble_width = page.evaluate("""
            document.querySelector('.msg-user').getBoundingClientRect().width
        """)
        conv_width = page.evaluate("""
            document.getElementById('conversation-log').getBoundingClientRect().width
        """)
        max_bubble = conv_width * 0.85
        report("user bubble <= 85% of chat width",
               user_bubble_width <= max_bubble + 2,
               f"bubble: {user_bubble_width:.0f}px, max: {max_bubble:.0f}px")

        agent_bubble_width = page.evaluate("""
            document.querySelector('.msg-agent').getBoundingClientRect().width
        """)
        report("agent bubble <= 85% of chat width",
               agent_bubble_width <= max_bubble + 2,
               f"bubble: {agent_bubble_width:.0f}px, max: {max_bubble:.0f}px")

        # ══════════════════════════════════════════════
        # Section 10: Safari Audio Workarounds
        # ══════════════════════════════════════════════
        section("Safari Audio Workarounds")

        # Check AudioContext / webkitAudioContext availability
        has_webkit_audio = page.evaluate("""
            typeof window.AudioContext !== 'undefined' ||
            typeof window.webkitAudioContext !== 'undefined'
        """)
        report("AudioContext or webkitAudioContext available", has_webkit_audio)

        # Check that the fallback pattern works at runtime
        has_fallback = page.evaluate("""
            (() => {
                try {
                    const ctx = new (window.AudioContext || window.webkitAudioContext)();
                    ctx.close();
                    return true;
                } catch(e) {
                    return false;
                }
            })()
        """)
        report("AudioContext fallback pattern works", has_fallback)

        # Check playsInline property is supported
        has_plays_inline = page.evaluate("""
            (() => {
                const audio = document.createElement('audio');
                audio.playsInline = true;
                return audio.playsInline === true;
            })()
        """)
        report("playsInline property supported", has_plays_inline)

        # ══════════════════════════════════════════════
        # Section 11: Hold-to-Talk Touch Events
        # ══════════════════════════════════════════════
        section("Hold-to-Talk Touch Events")

        # Verify the talk button has touch-action: none
        talk_touch_action = page.evaluate("""
            getComputedStyle(document.getElementById('talk-btn')).touchAction
        """)
        report("talk button has touch-action:none",
               talk_touch_action == "none",
               f"touch-action: {talk_touch_action}")

        # Verify user-select: none on talk button
        talk_user_select = page.evaluate("""
            (() => {
                const s = getComputedStyle(document.getElementById('talk-btn'));
                return s.userSelect || s.webkitUserSelect || '';
            })()
        """)
        report("talk button has user-select:none",
               talk_user_select == "none",
               f"user-select: {talk_user_select}")

        # Check talk button height (should be large touch target)
        talk_height = page.evaluate("""
            document.getElementById('talk-btn').getBoundingClientRect().height
        """)
        report("talk button >= 60px height (large touch target)",
               talk_height >= 60,
               f"height: {talk_height}px")

        # ══════════════════════════════════════════════
        # Section 12: dvh Units & Full Height
        # ══════════════════════════════════════════════
        section("Dynamic Viewport Height (dvh)")

        # Check CSS uses 100dvh (Safari mobile toolbar aware)
        has_dvh = page.evaluate("""
            (() => {
                for (const sheet of document.styleSheets) {
                    try {
                        for (const rule of sheet.cssRules) {
                            if (rule.cssText && rule.cssText.includes('100dvh'))
                                return true;
                        }
                    } catch(e) {}
                }
                return false;
            })()
        """)
        report("CSS uses 100dvh for Safari mobile", has_dvh)

        # Check -webkit-overflow-scrolling: touch via raw CSS fetch
        # (Chromium strips Safari-only properties during parsing, so we
        #  fetch the raw stylesheet text and search it directly)
        has_webkit_scroll = page.evaluate("""
            (async () => {
                try {
                    const resp = await fetch('/static/styles.css');
                    const text = await resp.text();
                    return text.includes('-webkit-overflow-scrolling') &&
                           text.includes('touch');
                } catch(e) {
                    return false;
                }
            })()
        """)
        report("CSS source includes -webkit-overflow-scrolling:touch", has_webkit_scroll)

        # ══════════════════════════════════════════════
        # Section 13: Select Dropdowns on Mobile
        # ══════════════════════════════════════════════
        section("Select Dropdowns (mobile)")

        # -webkit-appearance: none is set
        provider_appearance = page.evaluate("""
            (() => {
                const s = getComputedStyle(document.getElementById('provider-select'));
                return s.getPropertyValue('-webkit-appearance') ||
                       s.getPropertyValue('appearance') || '';
            })()
        """)
        report("provider select has -webkit-appearance:none",
               provider_appearance.strip() == "none",
               f"appearance: '{provider_appearance.strip()}'")

        # Check selects are full width
        select_width = page.evaluate("""
            document.getElementById('provider-select').getBoundingClientRect().width
        """)
        top_bar_width = page.evaluate("""
            document.getElementById('top-bar').getBoundingClientRect().width
        """)
        report("provider select is near full width",
               select_width >= top_bar_width * 0.8,
               f"select: {select_width:.0f}px, bar: {top_bar_width:.0f}px")

        # ══════════════════════════════════════════════
        # Done
        # ══════════════════════════════════════════════
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
