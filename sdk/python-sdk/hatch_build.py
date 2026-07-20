from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


def platform_key() -> str:
    system = {"darwin": "darwin", "linux": "linux", "win32": "win32"}.get(
        sys.platform, sys.platform
    )
    machine = platform.machine().lower()
    architecture = {"aarch64": "arm64", "amd64": "x64", "x86_64": "x64"}.get(
        machine, machine
    )
    return f"{system}-{architecture}"


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        if self.target_name != "wheel":
            raise RuntimeError(
                "The Python SDK is distributed as platform wheels only; "
                "source distributions are unsupported."
            )
        suffix = ".exe" if sys.platform == "win32" else ""
        key = platform_key()
        executable = (
            Path(self.root)
            / "src"
            / "browser_agent"
            / "bin"
            / key
            / f"browser-agent{suffix}"
        )
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise RuntimeError(
                f"Missing SDK executable for {key}: {executable}"
            )
        with tempfile.TemporaryDirectory(
            prefix="browser-agent-wheel-check-"
        ) as directory:
            environment = os.environ.copy()
            environment["HOME"] = directory
            environment["PATH"] = "" if os.name == "nt" else "/usr/bin:/bin"
            result = subprocess.run(
                [str(executable), "--sdk-self-test-json"],
                cwd=directory,
                env=environment,
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            if result.returncode != 0:
                raise RuntimeError(
                    "SDK executable self-test failed before wheel build: "
                    f"{result.stderr or result.stdout}"
                )
            expected = {
                "sharp": True,
                "tesseract": True,
                "pdf": True,
                "docx": True,
                "xlsx": True,
            }
            try:
                actual = json.loads(result.stdout.strip())
            except json.JSONDecodeError as error:
                raise RuntimeError(
                    "SDK executable self-test returned invalid JSON: "
                    f"{result.stdout}"
                ) from error
            if actual != expected:
                raise RuntimeError(
                    f"SDK executable self-test was incomplete: {actual}"
                )
            if re.search(
                r"Cannot (?:find|load).*module|native binding",
                result.stderr,
                re.IGNORECASE,
            ):
                raise RuntimeError(
                    "SDK executable emitted a missing-module or native-binding "
                    f"warning: {result.stderr}"
                )
        architecture = key.rsplit("-", 1)[-1]
        wheel_architecture = {
            "arm64": "aarch64" if sys.platform == "linux" else "arm64",
            "x64": "x86_64" if sys.platform != "win32" else "amd64",
        }.get(architecture, architecture)
        default_platform = {
            "darwin": f"macosx_13_0_{wheel_architecture}",
            "linux": f"linux_{wheel_architecture}",
            "win32": f"win_{wheel_architecture}",
        }.get(sys.platform)
        if default_platform is None:
            raise RuntimeError(f"Unsupported wheel platform: {key}")
        wheel_platform = os.environ.get(
            "BROWSER_AGENT_WHEEL_PLATFORM_TAG", default_platform
        )
        build_data["artifacts"].append(
            f"/{executable.relative_to(self.root).as_posix()}"
        )
        build_data["pure_python"] = False
        build_data["tag"] = f"py3-none-{wheel_platform}"
