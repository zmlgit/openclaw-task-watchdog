# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-05-13

### Added
- **Consecutive tool call detection**: Nudges the agent when it calls more than `consecutiveToolCallThreshold` tools without replying to the user (default: 5, rate-limited to once per minute)
- **User message silence detection**: Triggers a nudge when a user message goes unanswered for longer than `silenceThresholdMs` (default: 3 minutes)
- New hooks: `message_received` (track user message timestamps) and `before_agent_reply` (reset counters)
- New config options: `consecutiveToolCallThreshold` (2–20) and `silenceThresholdMs` (60000–1800000)
- Silence detection state maps cleaned up on `gateway_stop` and periodically pruned

## [1.2.0] - 2026-05-13

### Added
- MIT LICENSE file
- CHANGELOG.md for version tracking
- Architecture diagram in README
- "Why This Plugin" section explaining the pain points
- Badges for npm version, license, and OpenClaw compatibility
- `.gitignore` expanded with common patterns

### Changed
- README restructured with clearer sections and improved formatting
- Code review: confirmed type safety, error handling, and edge cases are solid

## [1.1.0] - 2026-05-12

### Fixed
- Interval leak: idempotency map cleanup `setInterval` now properly cleared on `gateway_stop`
- `heartbeatPatrol` logic: clear mutual exclusion with `timerPatrol`, works correctly when timer patrol is disabled
- Added `heartbeatPatrol` to `configSchema` for discoverability

### Changed
- `injectionTtlMs` config now respected instead of hardcoded 60s TTL
- Optional chaining on `api.runtime.system.*` calls for API version safety
- `reason` and `error` fields truncated to 200 chars to prevent oversized notifications
- `notifiedKeys` Map capped at 10,000 entries with oldest-half eviction
- `JSON.stringify` wrapped in try-catch for circular reference safety
- All timer cleanup unified under single `gateway_stop` handler

## [1.0.0] - 2026-05-11

### Added
- Initial release
- `subagent_ended` hook: detect abnormal outcomes and notify parent session
- `after_tool_call` hook: watch for abnormal exec exits
- `heartbeat_prompt_contribution` hook: inject stale-task patrol instructions
- `gateway_start` hook: timer-based patrol for periodic heartbeat checks
- Idempotency guard to prevent duplicate notifications
- Zero-config with sensible defaults
