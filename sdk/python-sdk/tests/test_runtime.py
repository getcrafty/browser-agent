from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from browser_agent import BrowserAgentTask
from browser_agent.runtime import (
    bundled_executable,
    bundled_manifest,
    create_runtime_files,
    platform_key,
    resolve_executable,
    verify_bundled_checksum,
    verify_executable,
)
from tests.helpers import FAKE_EXECUTABLE, fake_environment
from tests.test_options import valid


class ConfigTests(unittest.TestCase):
    def test_creates_private_files_and_preserves_owned_directories(self) -> None:
        with tempfile.TemporaryDirectory(prefix="py-config-") as root:
            workspace = str(Path(root) / "workspace")
            downloads = str(Path(root) / "downloads")
            files = create_runtime_files(
                valid(
                    download_directory=downloads,
                    workspace_directory=workspace,
                    executable_path="./chrome",
                    endpoint_url="https://example.com/v1",
                ),
                [BrowserAgentTask("go", "https://example.com")],
            )
            runtime_directory = str(Path(files.config_path).parent)
            self.assertEqual(os.stat(runtime_directory).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(files.config_path).st_mode & 0o777, 0o600)
            config = json.loads(Path(files.config_path).read_text())
            self.assertEqual(config["endpoint_url"], "https://example.com/v1")
            self.assertEqual(config["executable_path"], str(Path("chrome").resolve()))
            files.cleanup()
            files.cleanup()
            self.assertFalse(Path(runtime_directory).exists())
            self.assertTrue(Path(workspace).exists())
            self.assertTrue(Path(downloads).exists())

    def test_forwards_openrouter_provider_constraint(self) -> None:
        with tempfile.TemporaryDirectory(prefix="py-openrouter-config-") as root:
            files = create_runtime_files(
                valid(
                    provider="openrouter",
                    model="z-ai/glm-5.2",
                    reasoning_effort="xhigh",
                    api_key="secret",
                    openrouter_provider="baseten/fp8",
                    download_directory=str(Path(root) / "downloads"),
                ),
                [BrowserAgentTask("go")],
            )
            config = json.loads(Path(files.config_path).read_text())
            self.assertEqual(config["openrouter_provider"], "baseten/fp8")
            files.cleanup()

    def test_automatic_workspace_and_partial_failure_cleanup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="py-config-failures-") as root:
            options = valid(download_directory=str(Path(root) / "downloads"))
            with patch("browser_agent.runtime.os.getcwd", return_value=root):
                files = create_runtime_files(options, [BrowserAgentTask("go")])
                workspace = files.internal_paths[-1]
                self.assertIn(workspace, files.internal_paths)
                files.cleanup()
                self.assertFalse(Path(workspace).exists())

                with (
                    patch(
                        "browser_agent.runtime.Path.mkdir",
                        side_effect=OSError("failed"),
                    ),
                    patch("browser_agent.runtime.shutil.rmtree") as remove,
                    self.assertRaises(OSError),
                ):
                    create_runtime_files(options, [BrowserAgentTask("go")])
                self.assertGreaterEqual(remove.call_count, 2)

                with (
                    patch(
                        "browser_agent.runtime.os.chmod",
                        side_effect=OSError("failed"),
                    ),
                    patch("browser_agent.runtime.shutil.rmtree") as remove_runtime,
                    self.assertRaises(OSError),
                ):
                    create_runtime_files(options, [BrowserAgentTask("go")])
                remove_runtime.assert_called_once()

                with (
                    patch(
                        "browser_agent.runtime.tempfile.mkdtemp",
                        side_effect=OSError("failed"),
                    ),
                    patch("browser_agent.runtime.shutil.rmtree") as remove_nothing,
                    self.assertRaises(OSError),
                ):
                    create_runtime_files(options, [BrowserAgentTask("go")])
                remove_nothing.assert_not_called()

    def test_normalizes_platforms_and_architectures(self) -> None:
        for system, machine, expected in [
            ("darwin", "aarch64", "darwin-arm64"),
            ("linux", "AMD64", "linux-x64"),
            ("win32", "x86_64", "win32-x64"),
            ("other", "custom", "other-custom"),
        ]:
            self.assertEqual(platform_key(system, machine), expected)
        self.assertTrue(str(bundled_executable("win32", "amd64")).endswith(".exe"))


class ExecutableTests(unittest.IsolatedAsyncioTestCase):
    async def test_resolves_and_verifies_executable_outcomes(self) -> None:
        expected = (
            Path(__file__).parents[1] / "src" / "browser_agent" / "bin"
            / platform_key() / "browser-agent"
        )
        self.assertEqual(bundled_executable(), expected)
        self.assertTrue(str(bundled_manifest()).endswith("cli-manifest.json"))
        self.assertEqual(
            await resolve_executable(Path(FAKE_EXECUTABLE)),
            FAKE_EXECUTABLE,
        )
        with self.assertRaisesRegex(Exception, "unavailable"):
            await resolve_executable(Path("/definitely/missing"))
        with fake_environment("success"):
            await verify_executable(FAKE_EXECUTABLE)
        with fake_environment("version-mismatch"):
            with self.assertRaisesRegex(Exception, "incompatible"):
                await verify_executable(FAKE_EXECUTABLE)
        with self.assertRaisesRegex(Exception, "could not be started"):
            await verify_executable("/definitely/missing")
        with tempfile.TemporaryDirectory(prefix="py-executable-") as directory:
            malformed = Path(directory) / "malformed"
            malformed.write_text("#!/bin/sh\nprintf 'bad json'\n")
            malformed.chmod(0o700)
            with self.assertRaisesRegex(Exception, "incompatible"):
                await verify_executable(str(malformed))
            sleeper = Path(directory) / "sleeper"
            sleeper.write_text("#!/bin/sh\nsleep 1\n")
            sleeper.chmod(0o700)
            with self.assertRaisesRegex(Exception, "timed out"):
                await verify_executable(str(sleeper), 0.005)

    def test_verifies_bundled_checksum(self) -> None:
        with tempfile.TemporaryDirectory(prefix="py-checksum-") as directory:
            root = Path(directory)
            executable = root / "browser-agent"
            executable.write_bytes(b"binary")
            digest = hashlib.sha256(b"binary").hexdigest()
            manifest = root / "cli-manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "platforms": {
                            "linux-x64": {
                                "sha256": digest,
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            verify_bundled_checksum(executable, "linux-x64", manifest)
            executable.write_bytes(b"changed")
            with self.assertRaisesRegex(Exception, "verification failed"):
                verify_bundled_checksum(executable, "linux-x64", manifest)
