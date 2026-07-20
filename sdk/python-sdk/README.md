# Browser Agent Python SDK

Dependency-free asynchronous Python wrapper for the bundled Crafty Browser
Agent executable.

The SDK is distributed as platform wheels for macOS, Linux (glibc), and
Windows on ARM64 or x64. Each wheel contains the executable and its native
runtime assets; source distributions are intentionally unsupported.

## Getting started

Requires Python 3.11 or newer, Chrome or a compatible Chromium installation,
and a provider API key unless using `vllm`.

```sh
pip install browser-agent-python-sdk
```

The distribution is named `browser-agent-python-sdk`; import it as
`browser_agent`.

```python
from browser_agent import BrowserAgent, BrowserAgentTask

agent = BrowserAgent(
    provider="openai",
    model="gpt-5.4",
    download_directory="./downloads",
)

task = BrowserAgentTask(
    task="Find the first five articles on the OpenAI blog.",
    url="https://openai.com/news/",
)
```

## Agent configuration

All `BrowserAgent` constructor arguments are keyword-only.

| Option                | Default                       | Description                                                                      |
| --------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `provider`            | Required                      | Model provider.                                                                  |
| `model`               | Required                      | Non-empty provider model identifier.                                             |
| `download_directory`  | Required                      | Download directory; relative paths resolve from the current working directory.   |
| `reasoning_effort`    | Model-dependent               | Required when the SDK has no built-in capability information for the model.      |
| `api_key`             | Provider environment variable | API key for the model provider; whitespace-only values are ignored.              |
| `endpoint_url`        | —                             | Absolute HTTP(S) endpoint; required for `vllm`.                                  |
| `headless`            | `False`                       | Run Chromium without a visible window.                                           |
| `executable_path`     | System Chromium               | Chrome or compatible Chromium executable.                                        |
| `workspace_directory` | Temporary directory           | Agent file workspace; relative paths resolve from the current working directory. |
| `user_takeover_tool`  | `True`                        | Allow the agent to request user intervention.                                    |
| `max_steps`           | `50`                          | Positive integer maximum step count.                                             |
| `concurrency`         | `4`                           | Positive integer maximum concurrent task count.                                  |
| `runs_per_task`       | `1`                           | Positive integer number of executions per task.                                  |
| `retry_count`         | `2`                           | Non-negative integer retry count per failed task execution.                      |

### Providers and reasoning

```python
Provider: TypeAlias = Literal[
    "openai", "vllm", "together", "anthropic", "google"
]

ReasoningEffort: TypeAlias = Literal[
    "none", "minimal", "low", "medium", "high", "max", "enabled"
]
```

| Provider and model                                                                             | API-key environment     | Reasoning values                           | Default   |
| ---------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------ | --------- |
| OpenAI `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-terra`, or `gpt-5.6-sol` | `OPENAI_API_KEY`        | `none`, `minimal`, `low`, `medium`, `high` | `low`     |
| Together `zai-org/GLM-5.2`                                                                     | `TOGETHER_API_KEY`      | `none`, `high`, `max`                      | `high`    |
| vLLM model containing `qwen`                                                                   | Optional `VLLM_API_KEY` | `none`, `enabled`                          | `enabled` |
| vLLM model containing `glm`                                                                    | Optional `VLLM_API_KEY` | `none`                                     | `none`    |
| Anthropic models                                                                               | `ANTHROPIC_API_KEY`     | Any `ReasoningEffort`                      | Required  |
| Google models                                                                                  | `GOOGLE_API_KEY`        | Any `ReasoningEffort`                      | Required  |

`vllm` additionally requires `endpoint_url`.

## Task configuration

```python
@dataclass(frozen=True, slots=True)
class BrowserAgentTask:
    task: str
    url: str | None = None
    credentials: Sequence[BrowserAgentCredential] = ()


@dataclass(frozen=True, slots=True)
class BrowserAgentCredential:
    username: str
    password: str
    domain: str
```

| Field         | Description                                                |
| ------------- | ---------------------------------------------------------- |
| `task`        | Required, non-empty natural-language instruction.          |
| `url`         | Optional starting URL.                                     |
| `credentials` | Optional website login credentials available to this task. |

Credentials are login details for a website the task may need to access. They
are distinct from `api_key`, which authenticates with the model provider. Each
credential contains:

| Field      | Description                                                                           |
| ---------- | ------------------------------------------------------------------------------------- |
| `username` | Non-empty website account identifier, such as a username or email address.            |
| `password` | Non-empty password for the website account.                                           |
| `domain`   | Domain or origin the credential belongs to, used to scope it to the intended website. |

```python
import os

from browser_agent import BrowserAgentCredential, BrowserAgentTask

task = BrowserAgentTask(
    task="Open my account.",
    url="https://example.com",
    credentials=(
        BrowserAgentCredential(
            username="person@example.com",
            password=os.environ["EXAMPLE_PASSWORD"],
            domain="https://example.com",
        ),
    ),
)
```

`BrowserAgent.run()` accepts one `BrowserAgentTask` or a non-empty sequence of
tasks.
