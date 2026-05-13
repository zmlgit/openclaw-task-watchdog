import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/** Subagent outcomes that we consider "abnormal" and worth notifying about */
const DEFAULT_NOTIFY_OUTCOMES = new Set(["error", "timeout", "killed"]);

type WatchdogConfig = {
  subagentNotifyOn?: string[];
  execNotifyOnAbnormal?: boolean;
  injectionTtlMs?: number;
  heartbeatPatrol?: boolean;
  timerPatrol?: boolean;
  timerPatrolIntervalMs?: number;
  staleThresholdMs?: number;
  consecutiveToolCallThreshold?: number;
  silenceThresholdMs?: number;
};

/** Max entries in the idempotency map */
const IDEMPOTENCY_MAX_SIZE = 10_000;

export default definePluginEntry({
  id: "task-watchdog",
  name: "Task Watchdog",
  description:
    "Injects failure notifications into parent session when subagents fail or exec processes exit abnormally",
  register(api) {
    const log = {
      debug: (msg: string) => api.logger?.debug?.(msg),
      info: (msg: string) => api.logger?.info(msg),
      warn: (msg: string) => api.logger?.warn(msg),
      error: (msg: string) => api.logger?.error(msg),
    };

    // ── Idempotency guard ───────────────────────────────────────────────
    const notifiedKeys = new Map<string, number>(); // key → timestamp
    const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

    // ── Consecutive tool call tracking ──────────────────────────────────
    const consecutiveToolCalls = new Map<string, number>();
    const consecutiveNudgeCounts = new Map<string, number>();
    const userMessageTimestamps = new Map<string, number>();
    const silenceNotifiedKeys = new Map<string, number>();

    // ── Session → channel routing (for reply-to-feishu instructions) ────
    const sessionChannelMap = new Map<string, { channel: string; target?: string }>();

    function getReplyInstruction(sessionKey: string): string {
      const routing = sessionChannelMap.get(sessionKey);
      if (!routing) return "";
      const channel = routing.channel;
      const target = routing.target ? `, target='${routing.target}'` : "";
      return `\n⚠️ 回复要求：请通过 message(action=send, channel='${channel}'${target}) 回复到原始对话，不要只回复系统事件。`;
    }

    // ── Helper: extract parent session key from subagent key ────────────
    // e.g. "agent:main:subagent:xxx" → try to derive parent
    function extractParentSessionKey(subKey: string): string {
      // Best effort: strip the last :subagent:uuid segment
      const idx = subKey.indexOf(":subagent:");
      if (idx > 0) return subKey.slice(0, idx);
      return "main";
    }

    // Cleanup interval for expired idempotency keys — saved for gateway_stop
    const idempotencyCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of notifiedKeys) {
        if (now - ts > IDEMPOTENCY_TTL_MS) notifiedKeys.delete(key);
      }
      // Enforce max size: drop oldest half if over limit
      if (notifiedKeys.size > IDEMPOTENCY_MAX_SIZE) {
        const entries = [...notifiedKeys.entries()].sort((a, b) => a[1] - b[1]);
        const cutCount = Math.floor(entries.length / 2);
        for (let i = 0; i < cutCount; i++) notifiedKeys.delete(entries[i][0]);
      }
    }, 10 * 60 * 1000);

    function isNotified(idempotencyKey: string): boolean {
      return notifiedKeys.has(idempotencyKey);
    }

    function markNotified(idempotencyKey: string): void {
      notifiedKeys.set(idempotencyKey, Date.now());
    }

    // ── Utility: safe string truncation ────────────────────────────────
    function truncate(str: string | undefined | null, maxLen: number): string {
      if (!str) return "";
      return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
    }

    // ── Utility: safe JSON.stringify with circular reference guard ──────
    function safeStringify(value: unknown): string {
      try {
        return JSON.stringify(value ?? "");
      } catch {
        return String(value);
      }
    }

    // ── Unified notification function ──────────────────────────────────
    async function notify(
      text: string,
      idempotencyKey: string,
      sessionKey: string,
    ): Promise<boolean> {
      if (isNotified(idempotencyKey)) {
        log.debug(`[watchdog] already notified → ${idempotencyKey}`);
        return false;
      }

      try {
        // Append reply routing instruction so agent knows to respond via the original channel
        const replyHint = getReplyInstruction(sessionKey);
        const fullText = replyHint ? text + replyHint : text;
        const safeText = fullText.length > 1200 ? fullText.slice(0, 1200) + "..." : fullText;
        api.runtime?.system?.enqueueSystemEvent?.(safeText, { sessionKey });
        api.runtime?.system?.requestHeartbeat?.({
          source: "hook",
          intent: "immediate",
          reason: "watchdog notification",
        });
        markNotified(idempotencyKey);
        log.info(`[watchdog] notified via system event API → ${idempotencyKey}`);
        return true;
      } catch (err) {
        log.error(
          `[watchdog] system event API failed for key=${idempotencyKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return false;
    }

    // ── Hook 1: subagent_ended ──────────────────────────────────────────
    api.on("subagent_ended", async (event, ctx) => {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};
      const notifyOn = new Set(config.subagentNotifyOn ?? [...DEFAULT_NOTIFY_OUTCOMES]);

      const outcome = event.outcome;
      const parentKey = ctx.requesterSessionKey;
      const childKey = event.targetSessionKey;

      if (!parentKey) {
        log.debug(`[watchdog] subagent_ended: no requesterSessionKey, child=${childKey}`);
        return;
      }

      // ── Normal completion (outcome=ok): continuation reminder ──
      if (outcome === "ok") {
        const label = (event as Record<string, unknown>).label as string | undefined;
        const replyHint = getReplyInstruction(parentKey);
        const continuationMsg =
          `[Task Continuation] 子任务 ${label || childKey} 已完成。\n` +
          `请分析子任务结果并决定下一步：继续执行 / 汇报用户 / 询问用户。\n` +
          `不要收到结果后沉默。${replyHint}`;

        const continuationKey = `watchdog:continuation:${childKey}`;
        const ttlMs = config.injectionTtlMs ?? 300_000;

        // Primary: enqueueNextTurnInjection for precise session-scoped injection
        if (typeof api.enqueueNextTurnInjection === "function") {
          try {
            const result = await api.enqueueNextTurnInjection({
              sessionKey: parentKey,
              text: continuationMsg,
              idempotencyKey: continuationKey,
              placement: "prepend_context",
              ttlMs,
            });
            if (result && result.enqueued) {
              markNotified(continuationKey);
              log.info(`[watchdog] continuation injected via API → ${parentKey}`);
              return;
            }
            log.debug(`[watchdog] enqueueNextTurnInjection returned but not enqueued, falling back`);
          } catch (enqueueErr) {
            log.warn(`[watchdog] enqueueNextTurnInjection failed: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}, falling back`);
          }
        }

        // Fallback: in-process system event
        const safeText = continuationMsg.length > 1000 ? continuationMsg.slice(0, 1000) + "..." : continuationMsg;
        try {
          api.runtime?.system?.enqueueSystemEvent?.(safeText, { sessionKey: parentKey });
          api.runtime?.system?.requestHeartbeat?.({
            source: "hook",
            intent: "immediate",
            reason: "watchdog continuation",
            sessionKey: parentKey,
          });
          markNotified(continuationKey);
          log.info(`[watchdog] continuation via system event API → ${parentKey}`);
        } catch (err) {
          log.warn(`[watchdog] continuation notification failed for ${childKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      // ── Abnormal outcomes ──
      if (!outcome || !notifyOn.has(outcome)) {
        log.debug(`[watchdog] subagent_ended skipped: outcome=${outcome ?? "unknown"}`);
        return;
      }

      const reason = truncate(event.reason || outcome, 200);
      const errorMsg = truncate(event.error || "", 200);

      let message: string;
      switch (outcome) {
        case "timeout":
          message = `⚠️ Task Watchdog: 子任务超时 (${childKey})\n原因: ${reason}${errorMsg ? `\n错误: ${errorMsg}` : ""}\n请检查子 agent 状态或重新执行。`;
          break;
        case "killed":
          message = `⚠️ Task Watchdog: 子任务被终止 (${childKey})\n原因: ${reason}${errorMsg ? `\n错误: ${errorMsg}` : ""}\n可能是 OOM kill 或手动终止。`;
          break;
        case "reset":
          message = `⚠️ Task Watchdog: 子任务 session 被 reset (${childKey})\n原因: ${reason}\n子 agent 的 session 已被重置。`;
          break;
        case "deleted":
          message = `⚠️ Task Watchdog: 子任务 session 被删除 (${childKey})`;
          break;
        default:
          message = `⚠️ Task Watchdog: 子任务异常退出 (${childKey})\n结果: ${outcome}\n原因: ${reason}${errorMsg ? `\n错误: ${errorMsg}` : ""}`;
      }

      await notify(message, `watchdog:subagent:${childKey}`, parentKey);
    });

    // ── Silence Detection: config ───────────────────────────────────
    const SILENCE_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 min cooldown per session

    // ── Hook: message_received — track user messages ─────────────────────
    api.on("message_received", async (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      userMessageTimestamps.set(sessionKey, Date.now());
      // Reset consecutive tool call counter on new user message
      consecutiveToolCalls.set(sessionKey, 0);

      // Record channel routing info for reply instructions
      const channel = ctx.channelId || "";
      const target = ctx.conversationId || undefined;
      if (channel) {
        sessionChannelMap.set(sessionKey, { channel, target });
      }

      log.debug(`[watchdog] message_received: recorded timestamp for session=${sessionKey}`);
    });

    // ── Hook: before_agent_reply — reset counters ───────────────────────
    api.on("before_agent_reply", async (_event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      // Agent is replying — reset consecutive tool call counter
      consecutiveToolCalls.set(sessionKey, 0);
      // Clear the pending user message timestamp (agent is responding)
      userMessageTimestamps.delete(sessionKey);
      log.debug(`[watchdog] before_agent_reply: reset counters for session=${sessionKey}`);
    });

    // ── Hook 2: after_tool_call (exec + consecutive detection) ──────────────
    api.on("after_tool_call", async (event, ctx) => {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

           // ── Part A: Consecutive tool call detection (all tools) ──
      const threshold = config.consecutiveToolCallThreshold ?? 5;
      const currentCount = (consecutiveToolCalls.get(sessionKey) ?? 0) + 1;
      consecutiveToolCalls.set(sessionKey, currentCount);

      if (currentCount >= threshold) {
        // Determine target: if we're inside a subagent, escalate to parent session
        const isSubagent = /\bsubagent\b/i.test(sessionKey);
        const targetSession = isSubagent
          ? ((ctx as Record<string, unknown>).requesterSessionKey as string || extractParentSessionKey(sessionKey))
          : sessionKey;

        const nudgeKey = `watchdog:consecutive:${sessionKey}:${Date.now()}`;
        const lastNudgeTs = silenceNotifiedKeys.get(`consecutive:${sessionKey}`);
        const now = Date.now();

        // Rate limit: max 1 nudge per minute per session
        // Hard cap: after 10 nudges for same session, escalate to main
        const nudgeCount = (consecutiveNudgeCounts.get(sessionKey) ?? 0);
        const shouldEscalate = nudgeCount >= 10;
        const finalTarget = shouldEscalate ? "main" : targetSession;

        if (!lastNudgeTs || now - lastNudgeTs > 60_000) {
          consecutiveNudgeCounts.set(sessionKey, nudgeCount + 1);
          silenceNotifiedKeys.set(`consecutive:${sessionKey}`, now);

          let nudgeMsg: string;
          if (shouldEscalate) {
            nudgeMsg = `🔴 Task Watchdog ESCALATION: 子任务 ${sessionKey} 已连续触发 ${nudgeCount} 次工具调用告警仍未恢复。可能处于死循环，请检查并处理。`;
          } else if (isSubagent) {
            nudgeMsg = `📢 Task Watchdog: 子任务 ${sessionKey} 已连续调用 ${currentCount} 个工具。请检查子任务状态。`;
          } else {
            nudgeMsg = `📢 Task Watchdog: 你已经连续调用了 ${currentCount} 个工具，还没有给用户回复。请先向用户汇报当前进度再继续。`;
          }
          await notify(nudgeMsg, nudgeKey, finalTarget);
        }
      }

           // ── Part B: Original exec abnormal detection ──
      if (config.execNotifyOnAbnormal === false) return;
      if (event.toolName !== "exec") return;

      const runId = event.runId || ctx.runId;
      const idempotencyKey = runId
        ? `watchdog:exec:${runId}`
        : `watchdog:exec:${Date.now()}`;

      const resultStr = typeof event.result === "string" ? event.result : safeStringify(event.result);
      const errorStr = event.error || "";

      const isAbnormal =
        !!errorStr ||
        /exit\s*(?:code|status)[:\s]+[1-9]\d*/i.test(resultStr) ||
        /(?:terminated|killed)\s+by\s+signal\s+(?:SIGTERM|SIGKILL|SIGABRT|SIGSEGV)/i.test(resultStr) ||
        /oom\s*kill|out\s+of\s+memory/i.test(resultStr) ||
        /command\s+not\s+found|permission\s+denied/i.test(resultStr);

      if (!isAbnormal) {
        log.debug(`[watchdog] exec normal exit, skipping (runId=${runId})`);
        return;
      }

      const truncatedResult = truncate(resultStr, 500);
      const message = `⚠️ Task Watchdog: exec 异常退出\n${errorStr ? `错误: ${errorStr}\n` : ""}输出摘要: ${truncatedResult}\n\n请检查命令执行情况。`;

      await notify(message, idempotencyKey, sessionKey);
    });

    // ── Hook 3: heartbeat_prompt_contribution ────────────────────────────
    const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    api.on("heartbeat_prompt_contribution", async (_event, _ctx) => {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};

      // Clear mutual exclusion: heartbeat patrol only when timer patrol is off
      const useTimerPatrol = config.timerPatrol !== false;
      const useHeartbeatPatrol =
        config.heartbeatPatrol === true ||
        (!useTimerPatrol && config.heartbeatPatrol !== false);
      if (!useHeartbeatPatrol) return;

      const thresholdMin = Math.round(
        (config.staleThresholdMs ?? STALE_THRESHOLD_MS) / 60_000,
      );

      return {
        appendContext:
          `[Task Watchdog 巡检] 检查是否有停滞的后台任务：运行 \`openclaw tasks list --status running --json\`，` +
          `对 running 超过 ${thresholdMin} 分钟的任务汇报异常。` +
          `如果所有 running 任务都在正常推进，无需额外操作。`,
      };
    });

    // ── Hook 4: gateway_start — timer-based patrol ──────────────────────
    let timerPatrolTimer: ReturnType<typeof setInterval> | undefined;

    api.on("gateway_start", async (_event, _ctx) => {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};
      if (config.timerPatrol === false) return;

      const intervalMs = config.timerPatrolIntervalMs ?? 2 * 60 * 1000;

      // ── Immediate wake on gateway start ──
      // Trigger a heartbeat right away so the agent checks for
      // unreplied user messages and interrupted tasks after a restart.
      try {
        api.runtime?.system?.enqueueSystemEvent?.(
          "[Task Watchdog] Gateway 重启完成。请检查是否有未回复的用户消息或被中断的任务，立即处理。",
          { sessionKey: "main" },
        );
        api.runtime?.system?.requestHeartbeat?.({
          source: "hook",
          intent: "immediate",
          reason: "watchdog gateway restart recovery",
        });
        log.info("[watchdog] gateway_start: immediate wake triggered for restart recovery");
      } catch (wakeErr) {
        log.warn(`[watchdog] gateway_start immediate wake failed: ${wakeErr instanceof Error ? wakeErr.message : String(wakeErr)}`);
      }

      timerPatrolTimer = setInterval(() => {
        try {
          api.runtime?.system?.requestHeartbeat?.({
            source: "hook",
            intent: "immediate",
            reason: "watchdog timer patrol",
          });

                   // ── Silence detection patrol ──
          const config = (api.pluginConfig as WatchdogConfig) ?? {};
          const silenceThreshold = config.silenceThresholdMs ?? 180_000; // 3 minutes
          const now = Date.now();

          for (const [sessionKey, msgTs] of userMessageTimestamps) {
            const elapsed = now - msgTs;
            if (elapsed >= silenceThreshold) {
              const lastNudge = silenceNotifiedKeys.get(`silence:${sessionKey}`);
              if (lastNudge && now - lastNudge < SILENCE_IDEMPOTENCY_TTL_MS) continue;

              const elapsedMin = Math.round(elapsed / 60_000);
              const silenceMsg = `⏰ Task Watchdog: 用户消息已等待 ${elapsedMin} 分钟没有收到回复。请尽快回复用户。如果有正在执行的任务，先给用户一个进度汇报。`;
              const silenceKey = `watchdog:silence:${sessionKey}:${now}`;
              silenceNotifiedKeys.set(`silence:${sessionKey}`, now);

              try {
                api.runtime?.system?.enqueueSystemEvent?.(silenceMsg, { sessionKey });
                api.runtime?.system?.requestHeartbeat?.({
                  source: "hook",
                  intent: "immediate",
                  reason: "watchdog silence nudge",
                  sessionKey,
                });
                markNotified(silenceKey);
                log.info(`[watchdog] silence nudge sent for session=${sessionKey} (${elapsedMin}min)`);
              } catch (err) {
                log.warn(`[watchdog] silence nudge failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          // Cleanup expired silence state
          for (const [key, ts] of silenceNotifiedKeys) {
            if (now - ts > SILENCE_IDEMPOTENCY_TTL_MS) silenceNotifiedKeys.delete(key);
          }
          for (const [key, ts] of userMessageTimestamps) {
            // Remove entries older than 30 minutes (agent likely responded or session ended)
            if (now - ts > 30 * 60 * 1000) userMessageTimestamps.delete(key);
          }
          for (const [key] of consecutiveToolCalls) {
            // These are reset on before_agent_reply / message_received, but
            // prune stale entries here too (no activity seen in 10 min)
            // We don't have per-entry timestamps, so rely on the userMessageTimestamps
            // as a proxy — if that session has no recent user message, clean up.
            if (!userMessageTimestamps.has(key)) {
              consecutiveToolCalls.delete(key);
              consecutiveNudgeCounts.delete(key);
            }
          }

          log.debug("[watchdog] timer patrol: requested heartbeat + silence check");
        } catch (err) {
          log.debug(`[watchdog] timer patrol error: ${err}`);
        }
      }, intervalMs);

      log.info(`[watchdog] timer patrol started (interval=${intervalMs}ms)`);
    });

    // ── Unified cleanup on gateway_stop ─────────────────────────────────
    api.on("gateway_stop", () => {
      // Clean up idempotency cleanup timer
      clearInterval(idempotencyCleanupTimer);

      // Clean up timer patrol
      if (timerPatrolTimer !== undefined) {
        clearInterval(timerPatrolTimer);
        timerPatrolTimer = undefined;
        log.info("[watchdog] timer patrol stopped");
      }

      // Clean up silence detection maps
      userMessageTimestamps.clear();
      consecutiveToolCalls.clear();
      consecutiveNudgeCounts.clear();
      silenceNotifiedKeys.clear();
      sessionChannelMap.clear();

      log.info("[watchdog] all timers cleaned up");
    });

    log.info("[watchdog] Task Watchdog plugin registered (deadlock-safe edition)");
  },
});
