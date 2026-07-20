from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import tomllib
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
        key = os.environ.get("BROWSER_AGENT_SDK_PLATFORM")
        asset_directory = os.environ.get("BROWSER_AGENT_CLI_ASSET_DIR")
        manifest_value = os.environ.get("BROWSER_AGENT_CLI_MANIFEST")
        if not key or not asset_directory or not manifest_value:
            raise RuntimeError(
                "Wheel builds require BROWSER_AGENT_SDK_PLATFORM, "
                "BROWSER_AGENT_CLI_ASSET_DIR, and BROWSER_AGENT_CLI_MANIFEST."
            )
        manifest_path = Path(manifest_value).resolve()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        with (Path(self.root) / "pyproject.toml").open("rb") as project_file:
            project_version = tomllib.load(project_file)["project"]["version"]
        if manifest.get("version") != project_version:
            raise RuntimeError(
                f"CLI manifest version {manifest.get('version')} does not "
                f"match Python package version {project_version}."
            )
        target = manifest.get("platforms", {}).get(key)
        if not isinstance(target, dict):
            raise RuntimeError(f"CLI manifest does not support {key}.")
        executable = Path(asset_directory).resolve() / str(target["asset"])
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise RuntimeError(
                f"Missing SDK executable for {key}: {executable}"
            )
        actual_digest = hashlib.sha256(executable.read_bytes()).hexdigest()
        if actual_digest != target.get("sha256"):
            raise RuntimeError(
                f"CLI executable checksum mismatch for {key}: "
                f"expected {target.get('sha256')}, received {actual_digest}."
            )
        if key == platform_key():
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
        target_system, architecture = key.rsplit("-", 1)
        wheel_architecture = {
            "arm64": "aarch64" if target_system == "linux" else "arm64",
            "x64": "amd64" if target_system == "win32" else "x86_64",
        }.get(architecture, architecture)
        default_platform = {
            "darwin": f"macosx_13_0_{wheel_architecture}",
            "linux": f"manylinux_2_35_{wheel_architecture}",
            "win32": f"win_{wheel_architecture}",
        }.get(target_system)
        if default_platform is None:
            raise RuntimeError(f"Unsupported wheel platform: {key}")
        wheel_platform = os.environ.get(
            "BROWSER_AGENT_WHEEL_PLATFORM_TAG", default_platform
        )
        suffix = ".exe" if target_system == "win32" else ""
        force_include = build_data.setdefault("force_include", {})
        force_include[str(executable)] = (
            f"browser_agent/bin/{key}/browser-agent{suffix}"
        )
        force_include[str(manifest_path)] = "browser_agent/cli-manifest.json"
        build_data["pure_python"] = False
        build_data["tag"] = f"py3-none-{wheel_platform}"
