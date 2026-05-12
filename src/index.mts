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
};

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

    setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of notifiedKeys) {
        if (now - ts > IDEMPOTENCY_TTL_MS) notifiedKeys.delete(key);
      }
    }, 10 * 60 * 1000);

    function isNotified(idempotencyKey: string): boolean {
      return notifiedKeys.has(idempotencyKey);
    }

    function markNotified(idempotencyKey: string): void {
      notifiedKeys.set(idempotencyKey, Date.now());
    }

    // ── Unified notification function ──────────────────────────────────
    //
    // Uses gateway internal API directly — no CLI spawn, no deadlock.
    // api.runtime.system.enqueueSystemEvent + requestHeartbeat
    //
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
        const safeText = text.length > 1000 ? text.slice(0, 1000) + "..." : text;
        api.runtime.system.enqueueSystemEvent(safeText, { sessionKey });
        api.runtime.system.requestHeartbeat({
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
        const continuationMsg =
          `[Task Continuation] 子任务 ${label || childKey} 已完成。\n` +
          `请分析子任务结果并决定下一步：继续执行 / 汇报用户 / 询问用户。\n` +
          `不要收到结果后沉默。`;

        const continuationKey = `watchdog:continuation:${childKey}`;

        // Primary: enqueueNextTurnInjection for precise session-scoped injection
        if (typeof api.enqueueNextTurnInjection === "function") {
          try {
            const result = await api.enqueueNextTurnInjection({
              sessionKey: parentKey,
              text: continuationMsg,
              idempotencyKey: continuationKey,
              placement: "prepend_context",
              ttlMs: 60_000,
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
          api.runtime.system.enqueueSystemEvent(safeText, { sessionKey: parentKey });
          api.runtime.system.requestHeartbeat({
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

      const reason = event.reason || outcome;
      const errorMsg = event.error || "";

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

    // ── Hook 2: after_tool_call for exec ─────────────────────────────────
    api.on("after_tool_call", async (event, ctx) => {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};
      if (config.execNotifyOnAbnormal === false) return;
      if (event.toolName !== "exec") return;

      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      const runId = event.runId || ctx.runId;
      const idempotencyKey = runId
        ? `watchdog:exec:${runId}`
        : `watchdog:exec:${Date.now()}`;

      const resultStr = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
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

      const truncatedResult = resultStr.length > 500 ? resultStr.slice(0, 500) + "..." : resultStr;
      const message = `⚠️ Task Watchdog: exec 异常退出\n${errorStr ? `错误: ${errorStr}\n` : ""}输出摘要: ${truncatedResult}\n\n请检查命令执行情况。`;

      await notify(message, idempotencyKey, sessionKey);
    });

    // ── Hook 3: heartbeat_prompt_contribution ────────────────────────────
    const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    api.on("heartbeat_prompt_contribution", async (_event, _ctx) => {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};
      if (config.timerPatrol !== false) return;
      if ((config.heartbeatPatrol as boolean) === false) return;

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
    //
    // Previous implementation used `execSync("openclaw tasks list ...")`
    // which deadlocks when running inside the gateway process (CLI connects
    // to gateway WS → gateway blocks → deadlock).
    //
    // Now uses requestHeartbeat to trigger a heartbeat cycle, which invokes
    // heartbeat_prompt_contribution (Hook 3) that prompts the AI to check
    // for stale running tasks — all without any CLI spawn.
    //
    api.on("gateway_start", async (_event, _ctx) => {
      const config = (api.pluginConfig as WatchdogConfig) ?? {};
      if (config.timerPatrol === false) return;

      const intervalMs = config.timerPatrolIntervalMs ?? 2 * 60 * 1000;

      const timer = setInterval(() => {
        try {
          api.runtime.system.requestHeartbeat({
            source: "hook",
            intent: "immediate",
            reason: "watchdog timer patrol",
          });
          log.debug("[watchdog] timer patrol: requested heartbeat");
        } catch (err) {
          log.debug(`[watchdog] timer patrol error: ${err}`);
        }
      }, intervalMs);

      api.on("gateway_stop", () => {
        clearInterval(timer);
        log.info("[watchdog] timer patrol stopped");
      });

      log.info(`[watchdog] timer patrol started (interval=${intervalMs}ms)`);
    });

    log.info("[watchdog] Task Watchdog plugin registered (deadlock-safe edition)");
  },
});
