/**
 * Pure parser state reducer.
 *
 * State is now composite — it holds the transcript slice (committed turns +
 * active turn) and the session slices (config, usage, title) side by side.
 * A single reduce() call routes each NormalizedEvent to the appropriate slice:
 *
 *   transcript kinds (message / thinking / tool_call / tool_update / plan)
 *     → turn boundary logic + item fold (unchanged from before).
 *
 *   session kinds (config / mode_selected / commands / usage / title)
 *     → slice update, no turn boundary side-effect.
 *
 *   ignored → no-op on all slices.
 *
 *   turn_end / replay_end → finalize + commit the active transcript turn.
 *
 * Turn boundary rules (transcript only):
 *   OPEN (implicit):  a new user message (new item id) → close active + open.
 *   OPEN (lazy):      agent content with no active turn → open.
 *   CLOSE (explicit): 'turn_end' / 'replay_end' input → closeActive.
 *   CLOSE (implicit): next new user message while a turn is active → closeActive + open.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentState, AgentStatus } from '../models/agents';
import type { SessionCommand, SessionConfigState, SessionUsage } from '../models/config';
import { initialSessionConfigState } from '../models/config';
import { SESSION_PLAN_ID, type PlanState } from '../models/plan';
import type {
  TranscriptItem,
  TranscriptThinking,
  ToolNode,
  TranscriptTurnInitiator,
  TranscriptTurnOutcome,
  TranscriptTurn,
} from '../models/turns';
import { deriveConfigGroups } from './config-derive';
import { decodeSessionUpdate } from './decode';
import { makeMessageId, makeThinkingId, makeTurnId } from './ids';
import { foldItem, finalizeItems, type FoldEvent } from './item-fold';
import type { EnrichHook, NormalizedEvent } from './normalized-event';

type SynthesizedSegmentKind = 'message:user' | 'message:assistant' | 'thinking';

export interface SegmentState {
  open: SynthesizedSegmentKind | null;
  user: number;
  assistant: number;
  thinking: number;
}

export interface TranscriptSlice {
  committed: TranscriptTurn[];
  active: TranscriptTurn | null;
}

export interface ParserState {
  transcript: TranscriptSlice;
  config: SessionConfigState;
  usage: SessionUsage | null;
  title: string | null;
  pendingModeId: string | null;
  segment: SegmentState;
  agents: AgentState[];
  plan: PlanState | null;
}

export type ReducerInput =
  | { kind: 'update'; update: SessionUpdate; at: number }
  | { kind: 'event'; event: NormalizedEvent; at: number }
  | { kind: 'replay_start'; at: number }
  | { kind: 'replay_end'; at: number }
  | { kind: 'turn_end'; at: number; outcome?: TranscriptTurnOutcome };

export interface ReducerDeps {
  conversationId: string;
  enrich?: EnrichHook;
}

export function initialState(): ParserState {
  return {
    transcript: { committed: [], active: null },
    config: initialSessionConfigState,
    usage: null,
    title: null,
    pendingModeId: null,
    segment: initialSegment(),
    agents: [],
    plan: null,
  };
}

function initialSegment(): SegmentState {
  return {
    open: null,
    user: 0,
    assistant: 0,
    thinking: 0,
  };
}

function nextTurnIndex(t: TranscriptSlice): number {
  return t.committed.length + (t.active ? 1 : 0);
}

function nextTurnSeq(t: TranscriptSlice): number {
  return t.committed.at(-1)?.seq !== undefined ? t.committed.at(-1)!.seq + 1 : 0;
}

function openTurn(
  t: TranscriptSlice,
  deps: ReducerDeps,
  initiator: TranscriptTurnInitiator
): TranscriptSlice {
  const id = makeTurnId(deps.conversationId, nextTurnIndex(t));
  const turn: TranscriptTurn = { id, seq: nextTurnSeq(t), initiator, items: [] };
  return { ...t, active: turn };
}

/**
 * Finalize and commit the active turn to history.
 * No-op when there is no active turn.
 */
export function closeActive(
  t: TranscriptSlice,
  at: number,
  outcome?: TranscriptTurnOutcome
): TranscriptSlice {
  if (!t.active) return t;
  const committed: TranscriptTurn = {
    ...t.active,
    items: finalizeItems(t.active.items, at),
    ...(outcome !== undefined ? { outcome } : {}),
  };
  return { committed: [...t.committed, committed], active: null };
}

function flattenTurnItems(items: TranscriptItem[]): Array<TranscriptItem | ToolNode> {
  const flat: Array<TranscriptItem | ToolNode> = [];
  const visit = (item: TranscriptItem | ToolNode): void => {
    flat.push(item);
    if ('children' in item && item.children?.length) {
      for (const child of item.children) visit(child);
    }
  };
  for (const item of items) visit(item);
  return flat;
}

/**
 * Returns true when a late agent event provably belongs to an already-settled
 * turn: an assistant message/thinking chunk whose provider messageId produced
 * an item there, or a tool_update addressed to a tool call that lives there.
 */
function turnHasToolCall(turn: TranscriptTurn, toolCallId: string): boolean {
  return flattenTurnItems(turn.items).some(
    (item) => 'toolCallId' in item && item.toolCallId === toolCallId
  );
}

function continuesTurn(turn: TranscriptTurn, event: NormalizedEvent): boolean {
  if (event.kind === 'message' || event.kind === 'thinking') {
    if (event.kind === 'message' && event.role !== 'assistant') return false;
    if (event.messageId === null) return false;
    const messageItemId = makeMessageId(turn.id, event.messageId, 'assistant');
    return flattenTurnItems(turn.items).some(
      (item) =>
        item.id === messageItemId ||
        (item.kind === 'thinking' &&
          (item.segmentId === event.messageId ||
            item.segmentId.startsWith(`${event.messageId}:segment:`)))
    );
  }
  if (event.kind === 'tool_update') {
    return turnHasToolCall(turn, event.toolCallId);
  }
  return false;
}

/**
 * Rebuild synthesized-segment counters from a reopened turn's items so id-less
 * chunks arriving after the reopen cannot collide with existing auto ids.
 */
function segmentStateForTurn(turn: TranscriptTurn): SegmentState {
  const segment = initialSegment();
  for (const item of flattenTurnItems(turn.items)) {
    const match = /:(?:message|thinking):auto:(user|assistant|thinking):(\d+)$/.exec(item.id);
    if (!match) continue;
    const stream = match[1] as 'user' | 'assistant' | 'thinking';
    segment[stream] = Math.max(segment[stream], Number(match[2]) + 1);
  }
  return segment;
}

/**
 * A tool_update that carries nothing renderable — no title, output, terminal,
 * or diffs. When it addresses a tool call no turn knows, it is pure noise
 * (typically a late status notification for a settled turn) and must not open
 * a turn or disturb existing items.
 */
function isStatusOnlyToolUpdate(event: NormalizedEvent): boolean {
  return (
    event.kind === 'tool_update' &&
    event.title === null &&
    event.outputText === undefined &&
    event.terminalId === undefined &&
    event.diffs.length === 0
  );
}

/**
 * Reopen the last committed turn when it was settled by runtime quiescence and
 * the incoming event continues it. Quiesce is a heuristic timeout — a slow
 * stream can pause long enough to settle the turn mid-message, and without
 * reopening, the next chunk would land in a fresh turn under new item ids,
 * fragmenting one streamed message into many.
 */
function reopenQuiescedTurn(
  t: TranscriptSlice,
  event: NormalizedEvent
): { transcript: TranscriptSlice; segment: SegmentState } | null {
  const last = t.committed.at(-1);
  if (last?.outcome?.kind !== 'done' || last.outcome.reason !== 'quiesced') return null;
  if (!continuesTurn(last, event)) return null;
  const { outcome: _outcome, ...reopened } = last;
  return {
    transcript: { committed: t.committed.slice(0, -1), active: reopened },
    segment: segmentStateForTurn(reopened),
  };
}

/**
 * Returns true when the incoming user message represents a NEW turn open.
 * Uses the CURRENT active turn's id — not a tentative next-turn id — so the
 * lookup matches the items already stored in the turn.
 */
export function isNewUserMessage(
  active: TranscriptTurn | null,
  event: Extract<NormalizedEvent, { kind: 'message' }>,
  segment: SegmentState
): boolean {
  if (!active) return true;
  if (event.messageId === null) {
    if (segment.open === 'message:user') return false;
    return active.items.some((it) => it.kind !== 'message' || it.role !== 'user');
  }
  const id = makeMessageId(active.id, event.messageId, 'user');
  return !active.items.some((it) => it.kind === 'message' && it.id === id);
}

function segmentStream(kind: SynthesizedSegmentKind): keyof Omit<SegmentState, 'open'> {
  switch (kind) {
    case 'message:user':
      return 'user';
    case 'message:assistant':
      return 'assistant';
    case 'thinking':
      return 'thinking';
  }
}

function segmentKind(
  event: Extract<NormalizedEvent, { kind: 'message' | 'thinking' }>
): SynthesizedSegmentKind {
  if (event.kind === 'thinking') return 'thinking';
  return event.role === 'user' ? 'message:user' : 'message:assistant';
}

function synthesizedMessageId(segment: SegmentState, kind: SynthesizedSegmentKind): string {
  const stream = segmentStream(kind);
  return `auto:${stream}:${segment[stream]}`;
}

function closeSynthesizedSegment(
  transcript: TranscriptSlice,
  segment: SegmentState,
  at: number
): { transcript: TranscriptSlice; segment: SegmentState } {
  const active = transcript.active;
  if (!active || !segment.open) return { transcript, segment };

  const openKind = segment.open;
  const stream = segmentStream(openKind);
  const messageId = synthesizedMessageId(segment, openKind);
  const itemId =
    openKind === 'thinking'
      ? makeThinkingId(active.id, messageId)
      : makeMessageId(active.id, messageId, stream);
  let changed = false;
  const items = active.items.map((item): TranscriptItem => {
    if (openKind === 'thinking') {
      if (item.kind === 'thinking' && item.id === itemId && item.status === 'thinking') {
        changed = true;
        return { ...item, status: 'done' as const, durationMs: at - item.startedAt };
      }
      return item;
    }
    return item;
  });

  const nextSegment: SegmentState = {
    ...segment,
    open: null,
    [stream]: segment[stream] + 1,
  };

  if (!changed) return { transcript, segment: nextSegment };
  return { transcript: { ...transcript, active: { ...active, items } }, segment: nextSegment };
}

function resolveProviderThinkingMessageId(active: TranscriptTurn, messageId: string): string {
  for (let i = active.items.length - 1; i >= 0; i -= 1) {
    const item = active.items[i];
    if (
      item.kind === 'thinking' &&
      item.status === 'thinking' &&
      (item.segmentId === messageId || item.segmentId.startsWith(`${messageId}:segment:`))
    ) {
      return item.segmentId;
    }
  }

  const baseId = makeThinkingId(active.id, messageId);
  const base = active.items.find(
    (item): item is TranscriptThinking => item.kind === 'thinking' && item.id === baseId
  );
  if (!base || base.status !== 'done') return messageId;

  const prefix = `${messageId}:segment:`;
  const count = active.items.filter(
    (item) => item.kind === 'thinking' && item.segmentId.startsWith(prefix)
  ).length;
  return `${prefix}${count + 1}`;
}

function materializeEvent(
  transcript: TranscriptSlice,
  segment: SegmentState,
  event: NormalizedEvent,
  at: number
): { transcript: TranscriptSlice; segment: SegmentState; event: FoldEvent } {
  if (event.kind === 'message' || event.kind === 'thinking') {
    if (event.messageId === null) {
      const kind = segmentKind(event);
      const closed =
        segment.open === kind
          ? { transcript, segment }
          : closeSynthesizedSegment(transcript, segment, at);
      const messageId = synthesizedMessageId(closed.segment, kind);
      const nextSegment = { ...closed.segment, open: kind };
      return {
        transcript: closed.transcript,
        segment: nextSegment,
        event: { ...event, messageId },
      };
    }

    const closed = closeSynthesizedSegment(transcript, segment, at);
    if (event.kind === 'thinking' && closed.transcript.active) {
      return {
        ...closed,
        event: {
          ...event,
          messageId: resolveProviderThinkingMessageId(closed.transcript.active, event.messageId),
        },
      };
    }
    return { ...closed, event: event as FoldEvent };
  }

  const closed = closeSynthesizedSegment(transcript, segment, at);
  return { ...closed, event: event as FoldEvent };
}

function toAgentStatus(
  status: Extract<NormalizedEvent, { kind: 'subagent' }>['status']
): AgentStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'in_progress':
    case null:
      return 'running';
  }
}

function updateAgentSlice(
  agents: AgentState[],
  event: NormalizedEvent,
  launchTurnId: string | null,
  at: number
): AgentState[] {
  if (event.kind !== 'subagent' && event.kind !== 'subagent_update') return agents;

  const agentId = event.agentId ?? event.toolCallId;
  if (!agentId) return agents;

  const toolCallId = event.toolCallId ?? agentId;
  const idx = agents.findIndex(
    (agent) => agent.agentId === agentId || agent.toolCallId === toolCallId
  );
  const status = toAgentStatus(event.status);
  const completedAt =
    status === 'completed' || status === 'failed'
      ? { completedAt: at }
      : idx >= 0
        ? agents[idx].completedAt !== undefined
          ? { completedAt: agents[idx].completedAt }
          : {}
        : {};

  if (event.kind === 'subagent') {
    const next: AgentState = {
      ...(idx >= 0 ? agents[idx] : {}),
      agentId,
      toolCallId,
      launchTurnId,
      name: event.title,
      status,
      startedAt: idx >= 0 ? agents[idx].startedAt : at,
      ...(event.background !== undefined ? { background: event.background } : {}),
      ...(event.outputFile !== undefined ? { outputFile: event.outputFile } : {}),
      ...completedAt,
    };
    return idx >= 0 ? agents.map((agent, i) => (i === idx ? next : agent)) : [...agents, next];
  }

  const next: AgentState = {
    ...(idx >= 0
      ? agents[idx]
      : {
          agentId,
          toolCallId,
          launchTurnId,
          name: agentId,
          startedAt: at,
        }),
    agentId,
    toolCallId,
    status,
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
    ...(event.outputFile !== undefined ? { outputFile: event.outputFile } : {}),
    ...completedAt,
  };
  return idx >= 0 ? agents.map((agent, i) => (i === idx ? next : agent)) : [...agents, next];
}

function updatePlanSlice(
  plan: PlanState | null,
  event: NormalizedEvent,
  at: number
): PlanState | null {
  if (event.kind !== 'plan') return plan;
  return {
    id: SESSION_PLAN_ID,
    entries: event.entries.map((entry, index) => ({
      id: `${SESSION_PLAN_ID}:entry:${index}`,
      ...entry,
    })),
    updatedAt: at,
  };
}

function assertTurnInvariants(turn: TranscriptTurn): void {
  const ids = new Set<string>();
  const assertSortedSiblings = (items: TranscriptItem[] | ToolNode[]): void => {
    let previousSeq = -1;
    const siblingSeqs = new Set<number>();
    for (const item of items) {
      if (item.seq < previousSeq) {
        throw new Error(
          'AcpTranscriptParser invariant failed: sibling items are not sorted by seq'
        );
      }
      previousSeq = item.seq;
      if (siblingSeqs.has(item.seq)) {
        throw new Error(
          `AcpTranscriptParser invariant failed: duplicate sibling seq '${item.seq}'`
        );
      }
      siblingSeqs.add(item.seq);
    }
  };
  const visit = (item: TranscriptItem | ToolNode): void => {
    if (ids.has(item.id)) {
      throw new Error(`AcpTranscriptParser invariant failed: duplicate item id '${item.id}'`);
    }
    ids.add(item.id);
    if ('children' in item && item.children?.length) {
      assertSortedSiblings(item.children);
      for (const child of item.children) visit(child);
    }
  };

  let openThinking = 0;
  assertSortedSiblings(turn.items);
  for (const item of turn.items) {
    visit(item);
    if (item.kind === 'thinking' && item.status === 'thinking') openThinking += 1;
  }
  if (openThinking > 1) {
    throw new Error('AcpTranscriptParser invariant failed: multiple open thinking rows');
  }
}

function assertTranscriptInvariants(transcript: TranscriptSlice): void {
  if (process.env.NODE_ENV === 'production') return;
  let previousTurnSeq = -1;
  for (const turn of transcript.committed) {
    if (turn.seq <= previousTurnSeq) {
      throw new Error(
        'AcpTranscriptParser invariant failed: committed turns are not sorted by seq'
      );
    }
    previousTurnSeq = turn.seq;
  }
  if (transcript.active && transcript.active.seq <= previousTurnSeq) {
    throw new Error('AcpTranscriptParser invariant failed: active turn seq is not after history');
  }
  for (const turn of transcript.committed) assertTurnInvariants(turn);
  if (transcript.active) assertTurnInvariants(transcript.active);
}

/**
 * Pure reducer: (ParserState, ReducerInput, ReducerDeps) → ParserState.
 * All state changes return a new ParserState; no mutation occurs.
 */
export function reduce(s: ParserState, input: ReducerInput, deps: ReducerDeps): ParserState {
  if (input.kind === 'replay_start') {
    return initialState();
  }

  if (input.kind === 'replay_end') {
    const transcript = closeActive(s.transcript, input.at);
    return transcript === s.transcript
      ? { ...s, segment: initialSegment() }
      : { ...s, transcript, segment: initialSegment() };
  }

  if (input.kind === 'turn_end') {
    const transcript = closeActive(s.transcript, input.at, input.outcome);
    return transcript === s.transcript
      ? { ...s, segment: initialSegment() }
      : { ...s, transcript, segment: initialSegment() };
  }

  const event =
    input.kind === 'event'
      ? input.event
      : deps.enrich
        ? deps.enrich(decodeSessionUpdate(input.update), input.update)
        : decodeSessionUpdate(input.update);

  switch (event.kind) {
    case 'config': {
      const groups = deriveConfigGroups(event.options);
      const config: SessionConfigState = { ...s.config, ...groups };
      if (s.pendingModeId && config.modeOptions) {
        config.modeOptions = { ...config.modeOptions, selected: s.pendingModeId };
      }
      return {
        ...s,
        config,
        pendingModeId: config.modeOptions ? null : s.pendingModeId,
      };
    }
    case 'mode_selected': {
      if (!s.config.modeOptions) return { ...s, pendingModeId: event.modeId };
      const config: SessionConfigState = {
        ...s.config,
        modeOptions: { ...s.config.modeOptions, selected: event.modeId },
      };
      return { ...s, config, pendingModeId: null };
    }
    case 'commands': {
      const availableCommands = event.commands.map((c) => {
        const raw = c as unknown as {
          name: string;
          description: string;
          input?: { hint?: string };
        };
        const cmd: SessionCommand = {
          name: raw.name,
          description: raw.description,
          source: 'provider-command',
        };
        if (raw.input?.hint) cmd.inputHint = raw.input.hint;
        return cmd;
      });
      return { ...s, config: { ...s.config, availableCommands } };
    }
    case 'usage':
      return { ...s, usage: event.usage };
    case 'title':
      return { ...s, title: event.title };
    case 'ignored':
      return s;
    case 'subagent_update': {
      const agents = updateAgentSlice(s.agents, event, s.transcript.active?.id ?? null, input.at);
      return agents === s.agents ? s : { ...s, agents };
    }
    default:
      break; // falls through to transcript handling below
  }

  let t = s.transcript;
  let segment = s.segment;
  const plan = updatePlanSlice(s.plan, event, input.at);
  let agents = s.agents;

  // Status-only stray tool_updates addressed to no tool call in the active
  // turn are dropped BEFORE materializeEvent — which would otherwise close
  // the open synthesized segment (splitting id-less message/thinking streams)
  // — and before any state change that callers would read as activity.
  // The no-active-turn case is handled in the lazy-open branch below, after
  // the quiesce-reopen continuation check.
  if (
    event.kind === 'tool_update' &&
    isStatusOnlyToolUpdate(event) &&
    t.active &&
    !turnHasToolCall(t.active, event.toolCallId)
  ) {
    return s;
  }

  // OPEN boundary: a new user message starts a new turn.
  if (event.kind === 'message' && event.role === 'user') {
    if (isNewUserMessage(t.active, event, segment)) {
      t = closeActive(t, input.at);
      t = openTurn(t, deps, 'user');
      segment = initialSegment();
    }
  }

  // Lazy open: agent-initiated content with no active turn. A quiesce-settled
  // turn is reopened instead when the event provably continues it, and a
  // status-only stray tool_update never opens a turn at all — it would only
  // commit an empty turn later.
  if (!t.active) {
    const reopened = reopenQuiescedTurn(t, event);
    if (reopened) {
      t = reopened.transcript;
      segment = reopened.segment;
    } else if (isStatusOnlyToolUpdate(event)) {
      return s;
    } else {
      t = openTurn(t, deps, 'agent');
      segment = initialSegment();
    }
  }

  const materialized = materializeEvent(t, segment, event, input.at);
  t = materialized.transcript;
  segment = materialized.segment;

  const active = t.active!;
  agents = updateAgentSlice(agents, materialized.event, active.id, input.at);
  const items = foldItem(active.items, materialized.event, active.id, input.at);

  if (
    items === active.items &&
    t === s.transcript &&
    segment === s.segment &&
    agents === s.agents &&
    plan === s.plan
  ) {
    return s;
  }
  const transcript: TranscriptSlice =
    items === active.items ? t : { ...t, active: { ...active, items } };
  assertTranscriptInvariants(transcript);
  return { ...s, transcript, segment, agents, plan };
}
