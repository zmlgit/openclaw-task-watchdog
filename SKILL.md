# Task Watchdog

OpenClaw plugin that auto-notifies on subagent failures, exec errors, and stale tasks.

## Hooks

- **subagent_ended**: Detects abnormal outcomes (error/timeout/killed/reset/deleted) and notifies parent session
- **after_tool_call (exec)**: Watches for abnormal exec exits (non-zero, OOM, signals)
- **heartbeat_prompt_contribution**: Injects stale-task patrol instructions into heartbeat cycles
- **gateway_start**: Timer-based patrol that periodically triggers heartbeat checks

## Install

```bash
openclaw plugins install .
```

## TweetClaw Companion Use

Use Task Watchdog beside TweetClaw when an OpenClaw session delegates long X/Twitter monitoring, follower export, giveaway draw, or launch-reply analysis work to subagents or shell helpers. TweetClaw handles X/Twitter API actions; Task Watchdog only reports stale sessions, abnormal `exec` exits, and missing parent replies around that work.

## Config

All optional - works with defaults:

```json
{
  "task-watchdog": {
    "subagentNotifyOn": ["error", "timeout", "killed"],
    "execNotifyOnAbnormal": true,
    "timerPatrol": true,
    "timerPatrolIntervalMs": 120000,
    "staleThresholdMs": 1800000
  }
}
```
