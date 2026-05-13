# openclaw-task-watchdog

[![npm version](https://img.shields.io/npm/v/openclaw-task-watchdog.svg)](https://www.npmjs.com/package/openclaw-task-watchdog)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blueviolet)](https://github.com/nicepkg/openclaw)

**OpenClaw Task Watchdog Plugin** — Auto-notify on subagent failures, exec errors, and stale tasks.

[中文说明](#中文说明)

---

## Why This Plugin?

OpenClaw excels at dispatching subagents and running long tasks via `exec`. But there's a gap:

| Pain Point | What Happens |
|-----------|-------------|
| **Silent failures** | A subagent crashes or times out, but the parent session never finds out |
| **Forgotten tasks** | An `exec` command exits with error code 137 (OOM) — nobody notices |
| **Stale jobs** | A background task has been "running" for 45 minutes with no progress |
| **Manual checking** | Users repeatedly ask "is it done yet?" instead of getting proactive alerts |

**Task Watchdog** bridges this gap by monitoring task lifecycle events and injecting timely notifications into the parent session — so you always know when something needs attention.

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
| **`after_tool_call` (exec)** | Watches for abnormal `exec` exits — non-zero exit codes, OOM kills, signals, permission denied, command not found. |
| **`heartbeat_prompt_contribution`** | When timer patrol is off, injects patrol instructions into heartbeat cycles to check for stale running tasks. |
| **`gateway_start`** | Starts a timer-based patrol that periodically requests heartbeats to trigger stale-task checks. |

### Design Principles

- **Deadlock-safe**: Uses in-process API calls instead of spawning CLI commands
- **Idempotent**: Each notification uses an `idempotencyKey` to prevent duplicates
- **Zero-config**: Works out of the box with sensible defaults
- **Memory-safe**: Idempotency map capped at 10,000 entries with TTL-based eviction

## Installation

```bash
# Via OpenClaw plugin install
openclaw plugin install openclaw-task-watchdog

# Via npm
npm install openclaw-task-watchdog
```

## Configuration

All settings are optional. Configure via `openclaw.plugin.json` → `config`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `subagentNotifyOn` | `string[]` | `["error", "timeout", "killed"]` | Subagent outcomes that trigger notifications. Options: `error`, `timeout`, `killed`, `reset`, `deleted` |
| `execNotifyOnAbnormal` | `boolean` | `true` | Enable notifications on abnormal exec exits |
| `injectionTtlMs` | `integer` | `300000` (5 min) | TTL for next-turn injection messages (5000–600000 ms) |
| `timerPatrol` | `boolean` | `true` | Enable timer-based patrol on gateway start |
| `heartbeatPatrol` | `boolean` | `false` | Enable heartbeat-based patrol (only when timerPatrol is disabled) |
| `timerPatrolIntervalMs` | `integer` | `120000` (2 min) | Timer patrol interval (30000–600000 ms) |
| `staleThresholdMs` | `integer` | `1800000` (30 min) | How long before a task is considered stale (60000–7200000 ms) |

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
openclaw plugin install openclaw-task-watchdog
```

### 开发

```bash
npm install && npx tsc
```
