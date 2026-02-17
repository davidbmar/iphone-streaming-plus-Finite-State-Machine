"""Voice assistant REPL — text-only entry point.

Run with: python -m voice_assistant.main [--debug]

Features:
  - Rich colored output (green=user, blue=assistant, cyan=tools)
  - Spinner while the model is thinking
  - Auto-pulls Qwen 3 if not installed
  - Commands: quit/exit/q, clear
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from rich.console import Console
from rich.text import Text

from engine.orchestrator import OrchestratorConfig
from engine.workflow import WorkflowRunner
from engine.llm import list_ollama_models, pull_ollama_model

from .config import settings
from .tool_router import dispatch_tool_call
from .tools import get_all_schemas

console = Console()


def _setup_logging(debug: bool) -> None:
    level = logging.DEBUG if debug else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(name)-14s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    if debug:
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("httpcore").setLevel(logging.WARNING)


async def _tool_call_callback(name: str, args: dict) -> None:
    """Display tool calls in real time."""
    args_str = ", ".join(f"{k}={v!r}" for k, v in args.items()) if args else ""
    console.print(f"  [cyan dim]tool:[/] [cyan]{name}[/]({args_str})")


async def _workflow_start_callback(workflow_id, wf) -> None:
    """Display workflow activation."""
    console.print(f"  [magenta dim]workflow:[/] [magenta]{wf.name}[/] ({workflow_id})")


async def _workflow_state_callback(state_id, status, **kwargs) -> None:
    """Display workflow state transitions."""
    detail = kwargs.get("detail", "")
    if status == "active":
        msg = f"  [cyan dim]step:[/] [cyan]{state_id}[/]"
        if detail:
            msg += f"  ({detail})"
        console.print(msg)
    elif status == "visited":
        console.print(f"  [dim]  done: {state_id}[/]")


async def _workflow_exit_callback(workflow_id) -> None:
    """Display workflow completion."""
    console.print(f"  [magenta dim]workflow done:[/] {workflow_id}")


async def _ensure_ollama_model() -> str:
    """Check Ollama for preferred model, fall back, or offer to pull.

    Returns the active model name, or "" if none available.
    """
    installed = await list_ollama_models()
    installed_names: set[str] = set()
    for m in installed:
        installed_names.add(m["name"])
        if m["name"].endswith(":latest"):
            installed_names.add(m["name"][:-7])

    # Check preferred, then fallback
    if settings.ollama_model in installed_names:
        return settings.ollama_model
    if settings.ollama_fallback_model in installed_names:
        console.print(f"[yellow]Preferred model '{settings.ollama_model}' not found, "
                       f"using fallback '{settings.ollama_fallback_model}'[/]")
        return settings.ollama_fallback_model

    # Offer to pull
    for model_name in (settings.ollama_model, settings.ollama_fallback_model):
        console.print(f"\n[yellow]Model '{model_name}' is not installed.[/]")
        try:
            answer = console.input("[yellow]Pull it now? (y/n): [/]").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return ""
        if answer not in ("y", "yes"):
            continue
        console.print(f"[dim]Pulling {model_name}... this may take a few minutes.[/]")
        try:
            last_status = ""
            async for progress in pull_ollama_model(model_name):
                status = progress.get("status", "")
                if status != last_status:
                    console.print(f"  [dim]{status}[/]")
                    last_status = status
            console.print(f"[green]Model '{model_name}' ready.[/]\n")
            return model_name
        except Exception as e:
            console.print(f"[red]Pull failed: {e}[/]")

    return ""


async def _run_repl() -> None:
    # Ensure Ollama model is available
    active_model = await _ensure_ollama_model()
    if not active_model:
        console.print("[red]No model available. Install one with: ollama pull qwen3:8b[/]")
        return

    # Build workflow runner with Ollama config + tool registry
    config = OrchestratorConfig(
        provider="ollama",
        model=active_model,
        tools=get_all_schemas(),
        dispatch=dispatch_tool_call,
        max_iterations=settings.max_tool_calls_per_turn,
        max_history=settings.max_history_messages,
        on_tool_call=_tool_call_callback,
    )
    runner = WorkflowRunner(config=config)
    runner.on_workflow_start = _workflow_start_callback
    runner.on_workflow_state = _workflow_state_callback
    runner.on_workflow_exit = _workflow_exit_callback

    console.print(f"[bold]Voice Assistant[/] [dim]({active_model})[/]")
    console.print("[dim]Type 'quit' to exit, 'clear' to reset conversation.[/]\n")

    while True:
        try:
            user_input = console.input("[bold green]You:[/] ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[dim]Goodbye![/]")
            break

        if not user_input:
            continue
        if user_input.lower() in ("quit", "exit", "q"):
            console.print("[dim]Goodbye![/]")
            break
        if user_input.lower() == "clear":
            runner.clear_history()
            console.print("[dim]Conversation cleared.[/]\n")
            continue

        with console.status("[dim]Thinking...[/]", spinner="dots"):
            try:
                response = await runner.chat(user_input)
            except Exception as e:
                console.print(f"[red]Error: {e}[/]\n")
                continue

        console.print(f"[bold blue]Assistant:[/] {response}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Voice Assistant REPL")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    _setup_logging(args.debug)
    asyncio.run(_run_repl())


if __name__ == "__main__":
    main()
