from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from .errors import BrowserAgentError
from .models import BrowserAgentTask
from .options import ResolvedOptions

def platform_key(system: str | None = None, machine: str | None = None) -> str:
    system = system or sys.platform
    machine = (machine or platform.machine()).lower()
    architecture = {"aarch64": "arm64", "amd64": "x64", "x86_64": "x64"}.get(machine, machine)
    return f"{system}-{architecture}"
def bundled_executable(system: str | None = None, machine: str | None = None) -> Path:
    system = system or sys.platform
    suffix = ".exe" if system == "win32" else ""
    return Path(__file__).parent / "bin" / platform_key(system, machine) / f"browser-agent{suffix}"
def bundled_manifest() -> Path:
    return Path(__file__).parent / "cli-manifest.json"
def verify_bundled_checksum(
    executable: Path,
    key: str,
    manifest: Path | None = None,
) -> None:
    manifest = manifest or bundled_manifest()
    try:
        metadata = json.loads(manifest.read_text(encoding="utf-8"))
        expected = metadata["platforms"][key]["sha256"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise BrowserAgentError(
            "CLI_VERSION_INCOMPATIBLE",
            f"Bundled browser-agent checksum metadata is unavailable for {key}.",
        ) from error
    digest = hashlib.sha256()
    with executable.open("rb") as binary:
        for chunk in iter(lambda: binary.read(1024 * 1024), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    if actual != expected:
        raise BrowserAgentError(
            "CLI_VERSION_INCOMPATIBLE",
            f"Bundled browser-agent checksum verification failed for {key}.",
        )
async def resolve_executable(executable: Path | None = None) -> str:
    bundled = executable is None
    executable = executable or bundled_executable()
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise BrowserAgentError(
            "CLI_NOT_FOUND",
            f"Bundled browser-agent executable is unavailable for {platform_key()}.",
        )
    if bundled:
        verify_bundled_checksum(executable, platform_key())
    return str(executable)
async def verify_executable(executable: str, timeout: float = 5) -> None:
    try:
        process = await asyncio.create_subprocess_exec(
            executable, "--version-json",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout)
    except TimeoutError as error:
        process.kill()
        await process.wait()
        raise BrowserAgentError(
            "CLI_VERSION_INCOMPATIBLE", "Bundled browser-agent version check timed out."
        ) from error
    except OSError as error:
        raise BrowserAgentError(
            "CLI_NOT_FOUND", "Bundled browser-agent executable could not be started."
        ) from error
    try:
        if process.returncode or json.loads(stdout)["rpcProtocolVersion"] != 1:
            raise ValueError
    except (ValueError, KeyError, json.JSONDecodeError) as error:
        raise BrowserAgentError(
            "CLI_VERSION_INCOMPATIBLE",
            "Bundled browser-agent uses an incompatible RPC protocol.",
        ) from error
@dataclass(frozen=True, slots=True)
class ExecutableDependencies:
    resolve: Callable[[], Awaitable[str]]
    verify: Callable[[str], Awaitable[None]]
DEFAULT_EXECUTABLE_DEPENDENCIES = ExecutableDependencies(
    resolve_executable, verify_executable
)
@dataclass(slots=True)
class RuntimeFiles:
    config_path: str
    internal_paths: list[str]
    def cleanup(self) -> None:
        for owned in self.internal_paths:
            shutil.rmtree(owned, ignore_errors=True)
def create_runtime_files(options: ResolvedOptions, tasks: list[BrowserAgentTask]):
    owned: list[str] = []
    try:
        runtime = tempfile.mkdtemp(prefix="browser-agent-sdk-")
        owned.append(runtime)
        os.chmod(runtime, 0o700)
        workspace = options.workspace_directory
        if workspace is None:
            workspace = tempfile.mkdtemp(prefix=".browser-agent-workspace-", dir=os.getcwd())
            owned.append(workspace)
        Path(options.download_directory).mkdir(parents=True, exist_ok=True)
        Path(workspace).mkdir(parents=True, exist_ok=True)
        config_path = str(Path(runtime) / "config.yaml")
        config = {
            "provider": options.provider, "model": options.model,
            "reasoning_effort": options.reasoning_effort,
            **({"endpoint_url": options.endpoint_url} if options.endpoint_url else {}),
            "feature_flags": {"user_takeover_tool": options.user_takeover_tool},
            "headless": options.headless,
            **({"executable_path": options.executable_path} if options.executable_path else {}),
            "download_dir": options.download_directory, "file_workspace_root": workspace,
            "max_steps": options.max_steps, "concurrency": options.concurrency,
            "task_runs": options.runs_per_task, "task_run_retry_count": options.retry_count,
            "validator_lifecycle": {"mode": "terminal", "max_failures": 3},
            "wait_between_tasks_ms": 0, "save_steps_context": True, "save_task_logs": False,
            "step_messages_jsonl_path": str(Path(runtime) / "steps.jsonl"),
            "tasks": [{"task": task.task, **({"url": task.url} if task.url else {})}
                      for task in tasks],
        }
        descriptor = os.open(config_path, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(config, output)
        return RuntimeFiles(config_path, owned)
    except BaseException:
        for path in owned:
            shutil.rmtree(path, ignore_errors=True)
        raise
