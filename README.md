# openclaw-task-watchdog

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blueviolet)](https://github.com/openclaw/openclaw)

**OpenClaw Task Watchdog Plugin** - Auto-notify on subagent failures, exec errors, and stale tasks.

[中文说明](#中文说明)

---

## Why This Plugin?

OpenClaw excels at dispatching subagents and running long tasks via `exec`. But there's a gap:

| Pain Point | What Happens |
|-----------|-------------|
| **Silent failures** | A subagent crashes or times out, but the parent session never finds out |
| **Forgotten tasks** | An `exec` command exits with error code 137 (OOM) - nobody notices |
| **Stale jobs** | A background task has been "running" for 45 minutes with no progress |
| **Manual checking** | Users repeatedly ask "is it done yet?" instead of getting proactive alerts |

**Task Watchdog** bridges this gap by monitoring task lifecycle events and injecting timely notifications into the parent session - so you always know when something needs attention.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                      │
│                                                         │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  Subagent A  │    │       Task Watchdog          │   │
│  │  (running)   │    │                              │   │
│  └──────┬───────┘    │  Hooks:                      │   │
│         │            │  ├─ subagent_ended ──────────►│───┼──► notify parent
│  ┌──────▼───────┐    │  ├─ after_tool_call (exec) ─►│───┼──► notify session
│  │  Subagent B  │    │  ├─ heartbeat_prompt ───────►│───┼──► stale check
│  │  (failed!)   │    │  └─ gateway_start ──────────►│───┼──► timer patrol
│  └──────────────┘    │                              │   │
│                      │  Features:                   │   │
│  ┌──────────────┐    │  • Idempotency guard         │   │
│  │  exec cmd    │    │  • Safe truncation           │   │
│  │  (OOM kill!) │    │  • Circular-ref safe JSON    │   │
│  └──────────────┘    │  • Timer cleanup on stop     │   │
│                      └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Features

| Hook | What it does |
|------|-------------|
| **`subagent_ended`** | Detects abnormal subagent outcomes (error, timeout, killed, reset, deleted) and notifies the parent session. Sends continuation reminders on normal completions. |
| **`after_tool_call` (exec)** | Watches for abnormal `exec` exits - non-zero exit codes, OOM kills, signals, permission denied, command not found. |
| **`heartbeat_prompt_contribution`** | When timer patrol is off, injects patrol instructions into heartbeat cycles to check for stale running tasks. |
| **`gateway_start`** | Starts a timer-based patrol that periodically requests heartbeats to trigger stale-task checks. |
| **`message_received`** | Records user message timestamps for silence detection. Resets consecutive tool call counter. |
| **`before_agent_reply`** | Resets consecutive tool call counter and clears silence timer when agent replies. |

### Design Principles

- **Deadlock-safe**: Uses in-process API calls instead of spawning CLI commands
- **Idempotent**: Each notification uses an `idempotencyKey` to prevent duplicates
- **Zero-config**: Works out of the box with sensible defaults
- **Memory-safe**: Idempotency map capped at 10,000 entries with TTL-based eviction

### Silence Detection

The plugin detects two types of agent silence:

1. **Consecutive tool calls without reply**: If the agent calls more than `consecutiveToolCallThreshold` tools in a row without replying to the user, a nudge is injected (once per minute per session).
2. **User message timeout**: If a user sends a message but doesn't receive a reply within `silenceThresholdMs`, a silence nudge is triggered during the next timer patrol cycle.

## Installation

```bash
# From this checkout before npm publish
openclaw plugins install .
```

After the npm package is published:

```bash
openclaw plugins install openclaw-task-watchdog

# Via npm
npm install openclaw-task-watchdog
```

## Companion Workflow: TweetClaw Monitoring

Task Watchdog pairs well with [TweetClaw](https://github.com/Xquik-dev/tweetclaw) when an OpenClaw session runs long X/Twitter automation through subagents, cron-like heartbeats, or shell helpers around TweetClaw calls. Keep TweetClaw responsible for search tweets, search tweet replies, follower export, user lookup, monitor tweets, webhooks, giveaway draws, and approval-gated post tweets or post tweet replies. Use Task Watchdog to surface the surrounding OpenClaw failures that otherwise stay silent: stalled subagents, abnormal `exec` exits, or no parent-session reply after a launch or monitoring task starts.

Install both plugins explicitly:

```bash
openclaw plugins install @xquik/tweetclaw
openclaw plugins install openclaw-task-watchdog
```

Then configure TweetClaw credentials in its own OpenClaw plugin config and keep Task Watchdog on defaults unless you need shorter stale-task thresholds for launch monitoring.

## Configuration

All settings are optional. Configure via `openclaw.plugin.json` → `config`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `subagentNotifyOn` | `string[]` | `["error", "timeout", "killed"]` | Subagent outcomes that trigger notifications. Options: `error`, `timeout`, `killed`, `reset`, `deleted` |
| `execNotifyOnAbnormal` | `boolean` | `true` | Enable notifications on abnormal exec exits |
| `injectionTtlMs` | `integer` | `300000` (5 min) | TTL for next-turn injection messages (5000 to 600000 ms) |
| `timerPatrol` | `boolean` | `true` | Enable timer-based patrol on gateway start |
| `heartbeatPatrol` | `boolean` | `false` | Enable heartbeat-based patrol (only when timerPatrol is disabled) |
| `timerPatrolIntervalMs` | `integer` | `120000` (2 min) | Timer patrol interval (30000 to 600000 ms) |
| `staleThresholdMs` | `integer` | `1800000` (30 min) | How long before a task is considered stale (60000 to 7200000 ms) |
| `consecutiveToolCallThreshold` | `integer` | `5` | Number of consecutive tool calls without a reply before triggering a nudge (2 to 20) |
| `subagentConsecutiveThreshold` | `integer` | `15` | Consecutive tool call threshold for subagent sessions. Defaults to `consecutiveToolCallThreshold * 3` if not set |
| `silenceThresholdMs` | `integer` | `180000` (3 min) | How long after a user message without reply before triggering a silence nudge (60000 to 1800000 ms) |

Example:

```json
{
  "task-watchdog": {
    "subagentNotifyOn": ["error", "timeout", "killed", "reset"],
    "timerPatrolIntervalMs": 180000,
    "staleThresholdMs": 900000
  }
}
```

## Development

```bash
npm install
npx tsc          # build
npx tsc --watch  # dev mode
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history.

## License

[MIT](./LICENSE) © zml

---

## 中文说明

### 解决什么问题？

OpenClaw 通过子 agent 或 `exec` 执行长任务时，失败可能被忽略：

| 痛点 | 表现 |
|-----|------|
| 子 agent 崩溃或超时 | 父 session 不知道，继续等待 |
| exec 命令被 OOM kill | 无人发现，任务停滞 |
| 后台任务停滞 | 运行了 45 分钟没有进展 |
| 手动检查 | 用户反复问"做完了吗？" |

**Task Watchdog** 监控任务生命周期，自动注入通知。

### 安装

```bash
openclaw plugins install .
```

### 开发

```bash
npm install
npm run build
```
