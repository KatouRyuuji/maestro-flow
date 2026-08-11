// ---------------------------------------------------------------------------
// PiAdapter — spawns the pi coding-assistant CLI in non-interactive JSON mode
//
// pi output protocol (`pi -p --mode json`):
//   pi emits a JSONL event stream on stdout:
//     session / agent_start / turn_start / message_start / message_update /
//     message_end / turn_end / agent_end / agent_settled,
//     plus tool_execution_start / tool_execution_end around tool runs.
//
//   message_update carries an `assistantMessageEvent` discriminated on `type`:
//     text_start/text_delta/text_end      — streamed assistant text
//     thinking_start/thinking_delta/end   — streamed reasoning
//     toolcall_start/toolcall_delta/end   — streamed tool-call JSON
//   tool_execution_end carries the tool result + isError flag.
//   message_end with role=toolResult carries the result as a message.
//
//   The prompt is passed via stdin (pi reads it when no message args are
//   given), which avoids Windows command-line length limits for the assembled
//   protocol + specs prompt.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentType,
  AgentConfig,
  AgentProcess,
  ApprovalDecision,
} from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
import { EntryNormalizer } from './entry-normalizer.js';
import { loadEnvFile } from './env-file-loader.js';
import { StreamMonitor, DEFAULT_STREAM_TIMEOUT_MS } from './stream-monitor.js';
import { createStaleHandler } from './stale-handler.js';
import { killProcessTree } from './process-tree-kill.js';
import { cleanSpawnEnv } from './env-cleanup.js';

// ---------------------------------------------------------------------------
// pi JSONL event shapes (subset of fields we consume)
// ---------------------------------------------------------------------------

interface PiAssistantMessageEvent {
  type: string; // text_start | text_delta | text_end | thinking_start | thinking_delta | thinking_end | toolcall_start | toolcall_delta | toolcall_end
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
}

interface PiMessageUpdate {
  type: 'message_update';
  assistantMessageEvent: PiAssistantMessageEvent;
}

interface PiContentBlock {
  type: string; // text | thinking | toolCall
  text?: string;
  thinking?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
}

interface PiMessageEnd {
  type: 'message_end';
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content?: PiContentBlock[];
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
}

interface PiToolExecutionEnd {
  type: 'tool_execution_end';
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  result?: { content?: PiContentBlock[] };
}

interface PiTurnEnd {
  type: 'turn_end';
  message?: PiMessageEnd['message'];
}

type PiEvent =
  | PiMessageUpdate
  | PiMessageEnd
  | PiToolExecutionEnd
  | PiTurnEnd
  | { type: string };

// ---------------------------------------------------------------------------
// pi binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the pi CLI entry point.
 *
 * Prefers the installed package entry (dist/cli.js) so it can be spawned
 * directly with node — no shell, clean process-tree kill. Falls back to a
 * PATH lookup (`pi` shim; on Windows the .cmd shim requires a shell).
 */
function resolvePiEntry(): { cmd: string; args: string[]; usesShell: boolean } {
  const npmGlobalCandidates = [
    // Windows npm global install (%APPDATA%\npm\node_modules\...)
    join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js',
    ),
    // POSIX npm global installs
    '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    join(homedir(), '.local', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
    join(homedir(), 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
  ];
  for (const p of npmGlobalCandidates) {
    if (existsSync(p)) {
      return { cmd: process.execPath, args: [p], usesShell: false };
    }
  }
  // PATH fallback — pi shim (.cmd on Windows) needs a shell.
  return { cmd: 'pi', args: [], usesShell: true };
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class PiAdapter extends BaseAgentAdapter {
  readonly agentType = 'pi' as const;

  private readonly childProcesses = new Map<string, ChildProcess>();
  private readonly readlineInterfaces = new Map<string, ReadlineInterface>();
  private readonly streamMonitors = new Map<string, StreamMonitor>();
  private readonly stoppedEmitted = new Set<string>();
  /** Accumulated thinking deltas for the current assistant message. */
  private readonly thinkingBuffers = new Map<string, string>();
  /** True when text deltas were streamed for the current assistant message —
   *  the final message_end text is then skipped (already streamed). */
  private readonly textStreamed = new Map<string, boolean>();
  /** Tool results already emitted from tool_execution_end, keyed by Pi call id. */
  private readonly completedToolCallIds = new Map<string, Set<string>>();

  // --- Lifecycle hooks -----------------------------------------------------

  protected async doSpawn(
    processId: string,
    config: AgentConfig,
  ): Promise<AgentProcess> {
    const args = this.buildArgs(config);
    const { cmd, args: entryArgs, usesShell } = resolvePiEntry();

    const envFromFile = config.envFile ? loadEnvFile(config.envFile) : {};
    const envOverrides: Record<string, string | undefined> = { ...envFromFile, ...config.env };
    const childEnv = cleanSpawnEnv(envOverrides);

    const child = spawn(cmd, [...entryArgs, ...args], {
      cwd: config.workDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: usesShell,
      windowsHide: true,
      // POSIX: own process group so killProcessTree can signal the tree.
      detached: process.platform !== 'win32',
    });

    if (!child.stdout || !child.stdin || !child.stderr) {
      throw new Error('Failed to spawn pi: stdio streams not available');
    }

    // Prompt via stdin (avoids argv length limits), then close the write end.
    child.stdin.write(config.prompt);
    child.stdin.end();

    // Stale-stream monitor — shared cascade with other adapters.
    const staleTimeoutMs = config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    const monitor = new StreamMonitor(
      createStaleHandler({
        processId,
        child,
        timeoutMs: staleTimeoutMs,
        onStaleDetected: (message) =>
          this.emitEntry(processId, EntryNormalizer.error(processId, message, 'stream_stale')),
        isStopped: () => this.stoppedEmitted.has(processId),
        emitStopped: (reason) => this.emitStopped(processId, reason),
      }),
      staleTimeoutMs,
    );
    this.streamMonitors.set(processId, monitor);

    // stdout = JSONL event stream. Parse line-by-line.
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line: string) => {
      monitor.heartbeat();
      this.parseEvent(line, processId);
    });

    // stderr → error entries (non-JSON diagnostics).
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text.length === 0) return;
      this.emitEntry(processId, EntryNormalizer.error(processId, text, 'stderr'));
    });

    this.setupProcessListeners(child, processId);

    this.childProcesses.set(processId, child);
    this.readlineInterfaces.set(processId, rl);
    this.thinkingBuffers.set(processId, '');
    this.textStreamed.set(processId, false);

    return {
      id: processId,
      type: 'pi',
      status: 'running',
      config,
      startedAt: new Date().toISOString(),
      pid: child.pid,
    };
  }

  protected async doStop(processId: string): Promise<void> {
    const child = this.childProcesses.get(processId);
    if (!child) return;

    const proc = this.getProcess(processId);
    if (proc) {
      proc.status = 'stopping';
      this.emitEntry(
        processId,
        EntryNormalizer.statusChange(processId, 'stopping', 'User requested stop'),
      );
    }

    let exited = child.exitCode !== null || child.signalCode !== null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    child.once('exit', () => {
      exited = true;
      if (killTimer) clearTimeout(killTimer);
    });

    killProcessTree(child.pid, 'SIGTERM');
    killTimer = setTimeout(() => {
      if (!exited) killProcessTree(child.pid, 'SIGKILL');
    }, 5000);
    if (exited) clearTimeout(killTimer);

    this.cleanup(processId);
  }

  protected async doSendMessage(_processId: string, _content: string): Promise<void> {
    // pi -p is single-shot; follow-up messages are not supported headlessly.
    throw new Error('pi does not support interactive messages in -p mode');
  }

  protected async doRespondApproval(_decision: ApprovalDecision): Promise<void> {
    // pi -p never prompts for approval; project trust is controlled via --approve.
  }

  // --- Args ----------------------------------------------------------------

  protected buildArgs(config: AgentConfig): string[] {
    const args: string[] = ['-p', '--mode', 'json'];

    if (config.model) {
      args.push('--model', config.model);
    }

    // approvalMode='auto' (write mode) → trust project-local files
    // (AGENTS.md / CLAUDE.md) for this run; analysis mode keeps the user's
    // defaultProjectTrust setting.
    if (config.approvalMode === 'auto') {
      args.push('--approve');
    }

    return args;
  }

  // --- JSONL parsing -------------------------------------------------------

  private parseEvent(line: string, processId: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let event: PiEvent;
    try {
      event = JSON.parse(trimmed) as PiEvent;
    } catch {
      // Non-JSON lines (startup noise) are silently skipped
      return;
    }

    if (!event || typeof event !== 'object' || !('type' in event)) return;

    switch (event.type) {
      case 'message_update': {
        this.handleMessageUpdate(event as PiMessageUpdate, processId);
        break;
      }

      case 'message_end': {
        this.handleMessageEnd(event as PiMessageEnd, processId);
        break;
      }

      case 'tool_execution_end': {
        this.handleToolExecutionEnd(event as PiToolExecutionEnd, processId);
        break;
      }

      case 'turn_end': {
        this.handleUsage((event as PiTurnEnd).message, processId);
        break;
      }

      default:
        break;
    }
  }

  private handleMessageUpdate(event: PiMessageUpdate, processId: string): void {
    const ev = event.assistantMessageEvent;
    if (!ev || typeof ev !== 'object') return;

    switch (ev.type) {
      case 'text_delta': {
        const delta = ev.delta ?? '';
        if (delta.length > 0) {
          this.textStreamed.set(processId, true);
          this.emitEntry(
            processId,
            EntryNormalizer.assistantMessage(processId, delta, true),
          );
        }
        break;
      }

      case 'thinking_delta': {
        const delta = ev.delta ?? '';
        if (delta.length > 0) {
          const buf = this.thinkingBuffers.get(processId) ?? '';
          this.thinkingBuffers.set(processId, buf + delta);
        }
        break;
      }

      case 'thinking_end': {
        const buf = this.thinkingBuffers.get(processId) ?? '';
        this.thinkingBuffers.set(processId, '');
        if (buf.trim().length > 0) {
          this.emitEntry(processId, EntryNormalizer.thinking(processId, buf.trim()));
        }
        break;
      }

      case 'toolcall_end': {
        const call = ev.toolCall;
        if (call) {
          this.emitEntry(
            processId,
            EntryNormalizer.toolUse(processId, call.name ?? 'unknown', call.arguments ?? {}, 'running'),
          );
        }
        break;
      }

      default:
        // text_start / text_end / thinking_start / toolcall_start / toolcall_delta
        // are handled via their end/delta counterparts.
        break;
    }
  }

  private handleMessageEnd(event: PiMessageEnd, processId: string): void {
    const msg = event.message;
    if (!msg) return;

    if (msg.role === 'user') return;

    if (msg.role === 'assistant') {
      const blocks = msg.content ?? [];
      const text = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text ?? '')
        .join('');

      // If text deltas were streamed, the final text was already delivered —
      // skip to avoid duplicate output (the runner's renderEntry does the same).
      if (!this.textStreamed.get(processId) && text.length > 0) {
        this.emitEntry(processId, EntryNormalizer.assistantMessage(processId, text, false));
      }
      this.textStreamed.set(processId, false);
      this.thinkingBuffers.set(processId, '');
      return;
    }

    if (msg.role === 'toolResult') {
      // Pi normally emits tool_execution_end immediately before the matching
      // toolResult message. Keep this path only as a fallback for missed
      // execution events.
      if (msg.toolCallId) {
        const completed = this.completedToolCallIds.get(processId);
        if (completed?.delete(msg.toolCallId)) return;
      }
      const text = (msg.content ?? [])
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text ?? '')
        .join('');
      this.emitEntry(
        processId,
        EntryNormalizer.toolUse(
          processId,
          msg.toolName ?? 'unknown',
          {},
          msg.isError ? 'failed' : 'completed',
          text.slice(0, 4000),
        ),
      );
    }
  }

  private handleToolExecutionEnd(event: PiToolExecutionEnd, processId: string): void {
    if (event.toolCallId) {
      let completed = this.completedToolCallIds.get(processId);
      if (!completed) {
        completed = new Set<string>();
        this.completedToolCallIds.set(processId, completed);
      }
      completed.add(event.toolCallId);
    }
    const text = (event.result?.content ?? [])
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text ?? '')
      .join('');
    this.emitEntry(
      processId,
      EntryNormalizer.toolUse(
        processId,
        event.toolName ?? 'unknown',
        {},
        event.isError ? 'failed' : 'completed',
        text.slice(0, 4000),
      ),
    );
  }

  private handleUsage(
    message: { usage?: PiMessageEnd['message']['usage'] } | undefined,
    processId: string,
  ): void {
    const usage = message?.usage;
    if (!usage) return;
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    if (input === 0 && output === 0) return;
    this.emitEntry(processId, EntryNormalizer.tokenUsage(processId, input, output));
  }

  // --- Helpers -------------------------------------------------------------

  private setupProcessListeners(child: ChildProcess, processId: string): void {
    child.on('exit', (code: number | null, signal: string | null) => {
      const reason = signal ? `Terminated by signal: ${signal}` : `Exited with code: ${code ?? 'unknown'}`;
      this.emitStopped(processId, reason);
    });

    child.on('close', (code: number | null, signal: string | null) => {
      const reason = signal ? `Terminated by signal: ${signal}` : `Exited with code: ${code ?? 'unknown'}`;
      this.emitStopped(processId, reason);
    });

    child.on('error', (err: Error) => {
      this.emitEntry(processId, EntryNormalizer.error(processId, err.message, 'spawn_error'));
      this.emitErrored(processId, err.message);
    });
  }

  private emitErrored(processId: string, reason: string): void {
    if (this.stoppedEmitted.has(processId)) return;
    this.stoppedEmitted.add(processId);

    const proc = this.getProcess(processId);
    if (proc) proc.status = 'error';
    this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'error', reason));

    this.cleanup(processId);
    this.removeProcess(processId);
  }

  private emitStopped(processId: string, reason: string): void {
    if (this.stoppedEmitted.has(processId)) return;
    this.stoppedEmitted.add(processId);

    this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'stopped', reason));

    const proc = this.getProcess(processId);
    if (proc) proc.status = 'stopped';

    this.cleanup(processId);
    this.removeProcess(processId);
  }

  private cleanup(processId: string): void {
    const rl = this.readlineInterfaces.get(processId);
    if (rl) {
      rl.close();
      this.readlineInterfaces.delete(processId);
    }
    const monitor = this.streamMonitors.get(processId);
    if (monitor) {
      monitor.dispose();
      this.streamMonitors.delete(processId);
    }
    this.childProcesses.delete(processId);
    this.thinkingBuffers.delete(processId);
    this.textStreamed.delete(processId);
    this.completedToolCallIds.delete(processId);
    // Note: stoppedEmitted is intentionally NOT cleared here — it must persist
    // to guard against the readline close fallback timer firing after cleanup.
  }
}
