import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// ── Types ──────────────────────────────────────────────────────────────────

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
  subagentConsecutiveThreshold?: number;
  silenceThresholdMs?: number;
  feishuWebhookUrl?: string;
  forceFeishu?: boolean;
};

// ── Constants ──────────────────────────────────────────────────────────────

const IDEMPOTENCY_MAX_SIZE = 10_000;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SILENCE_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 min cooldown per session
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const PENDING_ALERTS_MAX = 20;
const ALERTS_PER_HEARTBEAT = 10;
const MESSAGE_TRUNCATE_LEN = 200;
const ALERT_MAX_LEN = 1200;
const CONTINUATION_MAX_LEN = 1000;

// ── Plugin Entry ───────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "task-watchdog",
  name: "Task Watchdog",
  description:
    "Dual-path notification: soft nudge via system event + forced heartbeat delivery for critical alerts. Tracks silence, consecutive tool calls, subagent failures, and exec abnormalities.",
  register(api) {
    const log = {
      debug: (msg: string) => api.logger?.debug?.(msg),
      info: (msg: string) => api.logger?.info(msg),
      warn: (msg: string) => api.logger?.warn(msg),
      error: (msg: string) => api.logger?.error(msg),
    };

    // ── In-memory state (all Maps have capacity limits and expiry cleanup) ──

    const notifiedKeys = new Map<string, number>(); // idempotencyKey → timestamp
    const pendingAlerts: string[] = []; // consumed by heartbeat_prompt_contribution
    const consecutiveToolCalls = new Map<string, number>(); // sessionKey → count
    const consecutiveNudgeCounts = new Map<string, number>(); // sessionKey → nudge count
    const userMessageTimestamps = new Map<string, number>(); // sessionKey → timestamp
    const userMessageContent = new Map<string, string>(); // sessionKey → last user message
    const silenceNotifiedKeys = new Map<string, number>(); // "silence:sessionKey" → timestamp
    const sessionChannelMap = new Map<string, { channel: string; target?: string }>(); // sessionKey → routing

    /** The primary (non-subagent) session key seen in message_received — escalation target */
    let lastMainSessionKey: string | undefined;

    // ── Helpers ────────────────────────────────────────────────────────────

    function truncate(str: string | undefined | null, maxLen: number): string {
      if (!str) return "";
      return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
    }

    function safeStringify(value: unknown): string {
      try {
        return JSON.stringify(value ?? "");
      } catch {
        return String(value);
      }
    }

    /** Strip the last :subagent:uuid segment to get parent session key */
    function extractParentSessionKey(subKey: string): string {
      const idx = subKey.indexOf(":subagent:");
      if (idx > 0) return subKey.slice(0, idx);
      return "main";
    }

    /** Build dynamic reply instruction from sessionChannelMap */
    function getReplyInstruction(sessionKey: string): string {
      const routing = sessionChannelMap.get(sessionKey);
      if (!routing) return "";
      const channel = routing.channel;
      const target = routing.target ? `, target='${routing.target}'` : "";
      return `\n⚠️ 回复要求：请通过 message(action=send, channel='${channel}'${target}) 回复到原始对话，不要只回复系统事件。`;
    }

    /** Format elapsed milliseconds as human-readable duration */
    function formatDuration(ms: number): string {
      const min = Math.round(ms / 60_000);
      if (min < 1) return "不到 1 分钟";
      if (min < 60) return `${min} 分钟`;
      const hr = Math.floor(min / 60);
      const remMin = min % 60;
      return remMin > 0 ? `${hr} 小时 ${remMin} 分钟` : `${hr} 小时`;
    }

    /** Compute wait duration string for a session */
    function getWaitDuration(sessionKey: string): string | null {
      const ts = userMessageTimestamps.get(sessionKey);
      if (!ts) return null;
      const elapsed = Date.now() - ts;
      if (elapsed < 5000) return null;
      return `已等待 ${formatDuration(elapsed)}`;
    }

    async function notifyViaFeishu(webhookUrl: string, text: string): Promise<void> {
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msg_type: "text",
            content: { text },
          }),
        });

        if (!response.ok) {
          log.warn(`[watchdog] Feishu webhook returned HTTP ${response.status}`);
        }
      } catch (err) {
        log.warn(`[watchdog] Feishu webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Idempotency guard ──────────────────────────────────────────────────

    const idempotencyCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of notifiedKeys) {
        if (now - ts > IDEMPOTENCY_TTL_MS) notifiedKeys.delete(key);
      }
      if (notifiedKeys.size > IDEMPOTENCY_MAX_SIZE) {
        const entries = [...notifiedKeys.entries()].sort((a, b) => a[1] - b[1]);
        const cutCount = Math.floor(entries.length / 2);
        for (let i = 0; i < cutCount; i++) notifiedKeys.delete(entries[i][0]);
      }
    }, 10 * 60 * 1000);

    function isNotified(key: string): boolean {
      return notifiedKeys.has(key);
    }
    function markNotified(key: string): void {
      notifiedKeys.set(key, Date.now());
    }

    // ── Unified notification function ──────────────────────────────────────
    //
    // Path A (soft nudge): enqueueSystemEvent → injected into current turn context
    // Path B (forced delivery): runHeartbeatOnce → independent heartbeat turn
    //
    // Critical alerts go through both paths. Non-critical alerts only go through Path A.
    // All alerts are pushed to pendingAlerts for heartbeat_prompt_contribution to inject.

    async function notify(
      text: string,
      idempotencyKey: string,
      sessionKey: string,
      critical: boolean = false,
    ): Promise<boolean> {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};

      if (isNotified(idempotencyKey)) {
        log.debug(`[watchdog] already notified → ${idempotencyKey}`);
        return false;
      }

      try {
        // ── Build full alert message ──
        let fullText = text;

        // Append user original message (truncated to 200 chars)
        const userMsg = userMessageContent.get(sessionKey);
        if (userMsg) {
          fullText += `\n\n📝 用户原始消息：${truncate(userMsg, MESSAGE_TRUNCATE_LEN)}`;
        }

        // Append wait duration if applicable
        const waitDuration = getWaitDuration(sessionKey);
        if (waitDuration) {
          fullText += `\n⏱️ ${waitDuration}`;
        }

        // Append dynamic reply route
        fullText += getReplyInstruction(sessionKey);

        // Cap total message length
        const safeText = fullText.length > ALERT_MAX_LEN
          ? fullText.slice(0, ALERT_MAX_LEN) + "..."
          : fullText;

        // ── Path A: soft nudge — inject into current turn context ──
        api.runtime?.system?.enqueueSystemEvent?.(safeText, { sessionKey });

        // ── Push to pending alerts for heartbeat_prompt_contribution ──
        pendingAlerts.push(safeText);
        if (pendingAlerts.length > PENDING_ALERTS_MAX) {
          pendingAlerts.splice(0, pendingAlerts.length - PENDING_ALERTS_MAX);
        }

        // Optional Feishu direct delivery, disabled by default.
        const feishuWebhookUrl = config.feishuWebhookUrl?.trim();
        if (config.forceFeishu === true && feishuWebhookUrl) {
          await notifyViaFeishu(feishuWebhookUrl, safeText);
        }

        // ── Path B: forced delivery for critical alerts ──
        if (critical) {
          api.runtime?.system?.runHeartbeatOnce?.({
            reason: "watchdog critical alert delivery",
            sessionKey,
            heartbeat: { target: "last" },
          }).catch((err: unknown) => {
            log.warn(`[watchdog] runHeartbeatOnce failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else {
          // For non-critical, just request a heartbeat (best-effort)
          api.runtime?.system?.requestHeartbeat?.({
            source: "hook",
            intent: "immediate",
            reason: "watchdog notification",
          });
        }

        markNotified(idempotencyKey);
        log.info(`[watchdog] notified (critical=${critical}) → ${idempotencyKey}`);
        return true;
      } catch (err) {
        log.error(
          `[watchdog] notify failed for key=${idempotencyKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return false;
    }

    // ── Hook: subagent_ended ───────────────────────────────────────────────

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
            log.debug(`[watchdog] enqueueNextTurnInjection not enqueued, falling back`);
          } catch (enqueueErr) {
            log.warn(`[watchdog] enqueueNextTurnInjection failed: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}, falling back`);
          }
        }

        // Fallback: enqueueSystemEvent + requestHeartbeat
        const safeText = truncate(continuationMsg, CONTINUATION_MAX_LEN);
        try {
          api.runtime?.system?.enqueueSystemEvent?.(safeText, { sessionKey: parentKey });
          api.runtime?.system?.requestHeartbeat?.({
            source: "hook",
            intent: "immediate",
            reason: "watchdog continuation",
            sessionKey: parentKey,
          });
          markNotified(continuationKey);
          log.info(`[watchdog] continuation via system event → ${parentKey}`);
        } catch (err) {
          log.warn(`[watchdog] continuation failed for ${childKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      // ── Abnormal outcomes (non-critical: only Path A) ──
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

    // ── Hook: message_received — track user messages ───────────────────────

    api.on("message_received", async (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      userMessageTimestamps.set(sessionKey, Date.now());

      const evt = event as Record<string, unknown>;
      const content = typeof evt.content === "string" ? evt.content : "";
      if (content) userMessageContent.set(sessionKey, content);

      // Reset consecutive tool call counter on new user message
      consecutiveToolCalls.set(sessionKey, 0);

      // Record channel routing for dynamic reply instructions
      const channel = ctx.channelId || "";
      const target = ctx.conversationId || undefined;
      if (channel) {
        sessionChannelMap.set(sessionKey, { channel, target });
      }

      // Track main (non-subagent) session key for escalation target
      if (!/\bsubagent\b/i.test(sessionKey)) {
        lastMainSessionKey = sessionKey;
      }

      log.debug(`[watchdog] message_received: session=${sessionKey}`);
    });

    // ── Hook: before_agent_reply — reset counters ─────────────────────────

    api.on("before_agent_reply", async (_event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      consecutiveToolCalls.set(sessionKey, 0);
      userMessageTimestamps.delete(sessionKey);
      log.debug(`[watchdog] before_agent_reply: reset counters for session=${sessionKey}`);
    });

    // ── Hook: after_tool_call (exec + consecutive detection) ──────────────

    api.on("after_tool_call", async (event, ctx) => {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      // ── Part A: Consecutive tool call detection ──
      const isSubagentSession = /:subagent:/i.test(sessionKey);
      const baseThreshold = config.consecutiveToolCallThreshold ?? 5;
      const subagentThreshold = config.subagentConsecutiveThreshold ?? 15;
      const threshold = isSubagentSession ? subagentThreshold : baseThreshold;

      const currentCount = (consecutiveToolCalls.get(sessionKey) ?? 0) + 1;
      consecutiveToolCalls.set(sessionKey, currentCount);

      if (currentCount >= threshold) {
        const isSubagent = /\bsubagent\b/i.test(sessionKey);
        const targetSession = isSubagent
          ? ((ctx as Record<string, unknown>).requesterSessionKey as string || extractParentSessionKey(sessionKey))
          : sessionKey;

        const nudgeKey = `watchdog:consecutive:${sessionKey}:${Date.now()}`;
        const lastNudgeTs = silenceNotifiedKeys.get(`consecutive:${sessionKey}`);
        const now = Date.now();

        // Rate limit: max 1 nudge per minute per session
        if (!lastNudgeTs || now - lastNudgeTs > 60_000) {
          const nudgeCount = (consecutiveNudgeCounts.get(sessionKey) ?? 0) + 1;
          consecutiveNudgeCounts.set(sessionKey, nudgeCount);
          silenceNotifiedKeys.set(`consecutive:${sessionKey}`, now);

          // Hard cap: after 10 nudges → escalation to main session (critical = dual-path)
          const shouldEscalate = nudgeCount >= 10;
          const escalationTarget = lastMainSessionKey || extractParentSessionKey(sessionKey);
          const finalTarget = shouldEscalate ? escalationTarget : targetSession;

          let nudgeMsg: string;
          if (shouldEscalate) {
            nudgeMsg = `🔴 Task Watchdog ESCALATION: 子任务 ${sessionKey} 已连续触发 ${nudgeCount} 次工具调用告警仍未恢复。可能处于死循环，请检查并处理。`;
          } else if (isSubagent) {
            nudgeMsg = `📢 Task Watchdog: 子任务 ${sessionKey} 已连续调用 ${currentCount} 个工具。请检查子任务状态。`;
          } else {
            nudgeMsg = `📢 Task Watchdog: 你已经连续调用了 ${currentCount} 个工具，还没有给用户回复。`;
          }

          await notify(nudgeMsg, nudgeKey, finalTarget, shouldEscalate);
        }
      }

      // ── Part B: exec abnormal exit detection ──
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
        log.debug(`[watchdog] exec normal exit (runId=${runId})`);
        return;
      }

      const truncatedResult = truncate(resultStr, 500);
      const message = `⚠️ Task Watchdog: exec 异常退出\n${errorStr ? `错误: ${errorStr}\n` : ""}输出摘要: ${truncatedResult}\n\n请检查命令执行情况。`;

      await notify(message, idempotencyKey, sessionKey);
    });

    // ── Hook: heartbeat_prompt_contribution ────────────────────────────────

    api.on("heartbeat_prompt_contribution", async (_event, ctx) => {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};
      const parts: string[] = [];
      const sessionKey = ctx?.sessionKey;

      // ── Drain pending alerts (up to ALERTS_PER_HEARTBEAT) ──
      if (pendingAlerts.length > 0) {
        const alerts = pendingAlerts.splice(0, ALERTS_PER_HEARTBEAT);

        // Build reply instruction dynamically from channel map
        const routing = sessionKey ? sessionChannelMap.get(sessionKey) : undefined;
        const channelHint = routing
          ? `请立即通过 message(action=send, channel='${routing.channel}'${routing.target ? `, target='${routing.target}'` : ""}) 回复用户。不要沉默。`
          : "请立即回复用户。不要沉默。";

        parts.push("[Task Watchdog 告警] 以下是需要立即处理的事项：");
        alerts.forEach((alert, i) => {
          parts.push(`${i + 1}. ${alert}`);
        });
        parts.push(channelHint);
      }

      // ── Silence detection: check current session ──
      if (sessionKey) {
        const silenceThreshold = config.silenceThresholdMs ?? 180_000;
        const lastMsgTs = userMessageTimestamps.get(sessionKey);
        if (lastMsgTs) {
          const elapsed = Date.now() - lastMsgTs;
          if (elapsed >= silenceThreshold) {
            parts.push(`[Task Watchdog 沉默检测] 用户消息已等待 ${formatDuration(elapsed)} 没有回复。请立即回复。`);
          }
        }
      }

      // ── Stale task patrol (only when heartbeat patrol is enabled) ──
      const useTimerPatrol = config.timerPatrol !== false;
      const useHeartbeatPatrol =
        config.heartbeatPatrol === true ||
        (!useTimerPatrol && config.heartbeatPatrol !== false);
      if (useHeartbeatPatrol) {
        const thresholdMin = Math.round(
          (config.staleThresholdMs ?? STALE_THRESHOLD_MS) / 60_000,
        );
        parts.push(
          `[Task Watchdog 巡检] 检查是否有停滞的后台任务：运行 \`openclaw tasks list --status running --json\`，` +
          `对 running 超过 ${thresholdMin} 分钟的任务汇报异常。`,
        );
      }

      if (parts.length === 0) return {};

      return {
        appendContext: parts.join("\n"),
      };
    });

    // ── Hook: gateway_start — timer-based patrol ──────────────────────────

    let timerPatrolTimer: ReturnType<typeof setInterval> | undefined;

    api.on("gateway_start", async (_event, _ctx) => {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};
      if (config.timerPatrol === false) return;

      const intervalMs = config.timerPatrolIntervalMs ?? 120_000;

      // ── Immediate wake on gateway restart (critical = dual-path) ──
      const wakeSessionKey = lastMainSessionKey || "main";
      const restartMsg =
        "[Task Watchdog] Gateway 重启完成。请检查是否有未回复的用户消息或被中断的任务，立即处理。";
      await notify(restartMsg, `watchdog:gateway:restart:${Date.now()}`, wakeSessionKey, true);
      log.info("[watchdog] gateway_start: restart recovery notification sent");

      // ── Timer patrol loop ──
      timerPatrolTimer = setInterval(async () => {
        try {
          api.runtime?.system?.requestHeartbeat?.({
            source: "hook",
            intent: "immediate",
            reason: "watchdog timer patrol",
          });

          // ── Silence detection patrol ──
          const silenceThreshold = config.silenceThresholdMs ?? 180_000;
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

              // Silence detection = critical → dual-path (A+B)
              await notify(silenceMsg, silenceKey, sessionKey, true);
              log.info(`[watchdog] silence nudge sent for session=${sessionKey} (${elapsedMin}min)`);
            }
          }

          // ── Cleanup expired state ──
          for (const [key, ts] of silenceNotifiedKeys) {
            if (now - ts > SILENCE_IDEMPOTENCY_TTL_MS) silenceNotifiedKeys.delete(key);
          }
          for (const [key, ts] of userMessageTimestamps) {
            if (now - ts > 30 * 60 * 1000) userMessageTimestamps.delete(key);
          }
          for (const [key] of consecutiveToolCalls) {
            if (!userMessageTimestamps.has(key)) {
              consecutiveToolCalls.delete(key);
              consecutiveNudgeCounts.delete(key);
            }
          }

          log.debug("[watchdog] timer patrol: heartbeat requested + silence check done");
        } catch (err) {
          log.debug(`[watchdog] timer patrol error: ${err}`);
        }
      }, intervalMs);

      log.info(`[watchdog] timer patrol started (interval=${intervalMs}ms)`);
    });

    // ── Hook: gateway_stop — unified cleanup ──────────────────────────────

    api.on("gateway_stop", () => {
      clearInterval(idempotencyCleanupTimer);

      if (timerPatrolTimer !== undefined) {
        clearInterval(timerPatrolTimer);
        timerPatrolTimer = undefined;
        log.info("[watchdog] timer patrol stopped");
      }

      notifiedKeys.clear();
      pendingAlerts.length = 0;
      consecutiveToolCalls.clear();
      consecutiveNudgeCounts.clear();
      userMessageTimestamps.clear();
      userMessageContent.clear();
      silenceNotifiedKeys.clear();
      sessionChannelMap.clear();

      log.info("[watchdog] all timers and state cleaned up");
    });

    log.info("[watchdog] Task Watchdog plugin registered (dual-path notification architecture)");
  },
});
