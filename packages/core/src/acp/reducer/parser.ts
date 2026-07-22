/**
 * AcpTranscriptParser — stateful wrapper around the pure composite reducer.
 *
 * A single push() call folds one raw ACP SessionUpdate into all slices:
 *   - transcript (committed turns + active turn)
 *   - config     (modelOptions / efforts / modeOptions / availableCommands)
 *   - usage      (contextUsed / contextSize / cost)
 *   - title      (session info title)
 *
 * Two usage modes:
 *
 *   Live streaming (push / endTurn):
 *     const parser = new AcpTranscriptParser({ conversationId, enrich });
 *     parser.push(sessionUpdate);
 *     parser.endTurn();             // called when prompt() resolves
 *     parser.history;               // committed turns
 *     parser.activeTurn;            // in-flight turn, or null
 *     parser.config;                // latest config state
 *     parser.usage;                 // latest usage, or null
 *     parser.title;                 // latest title, or null
 *
 *   Bounded replay (static):
 *     const result = AcpTranscriptParser.replay(updates, { conversationId, enrich });
 *     result.committed;             // finalized turns
 *     result.active;                // null after bounded replay
 *     result.config;                // SessionConfigState
 *     result.usage;                 // SessionUsage | null
 *     result.title;                 // string | null
 *
 * Provider enrichment:
 *   Pass an optional EnrichHook; baseline decoding is owned by the reducer.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentState } from '../models/agents';
import type { SessionConfigState, SessionUsage } from '../models/config';
import type { PlanState } from '../models/plan';
import type { TranscriptTurn, TranscriptTurnOutcome } from '../models/turns';
import type { EnrichHook, NormalizedEvent } from './normalized-event';
import {
  initialState,
  reduce,
  type ParserState,
  type ReducerDeps,
  type ReducerInput,
} from './reducer';

export interface AcpTranscriptParserDeps {
  conversationId: string;
  enrich?: EnrichHook;
}

export type ReplayResult = {
  committed: TranscriptTurn[];
  active: TranscriptTurn | null;
  config: SessionConfigState;
  usage: SessionUsage | null;
  title: string | null;
  agents: AgentState[];
  plan: PlanState | null;
};

export type ReplayEntry = SessionUpdate | { update: SessionUpdate; ts?: number; at?: number };

export class AcpTranscriptParser {
  private state: ParserState;
  private readonly deps: ReducerDeps;
  private _revision = 0;

  constructor(deps: AcpTranscriptParserDeps) {
    this.state = initialState();
    this.deps = { ...deps };
  }

  /**
   * Monotonic counter bumped whenever a push actually changed parser state.
   * Callers compare revisions around a push to tell no-op events (e.g. stray
   * status-only tool updates) from real transcript activity.
   */
  get revision(): number {
    return this._revision;
  }

  private apply(input: ReducerInput): void {
    const next = reduce(this.state, input, this.deps);
    if (next !== this.state) this._revision += 1;
    this.state = next;
  }

  /**
   * Feed one raw ACP SessionUpdate into the parser.
   * Routes to the appropriate slice (transcript or config/usage/title).
   * For transcript-affecting variants, may open or close a turn.
   */
  push(update: SessionUpdate, at = Date.now()): void {
    this.apply({ kind: 'update', update, at });
  }

  pushEvent(event: NormalizedEvent, at = Date.now()): void {
    this.apply({ kind: 'event', event, at });
  }

  /**
   * Explicitly close the active transcript turn.
   * Call this when prompt() resolves (stopReason is discarded — it belongs to
   * the session state machine, not the transcript).
   * No-op when there is no active turn.
   */
  endTurn(at = Date.now()): void {
    this.apply({ kind: 'turn_end', at });
  }

  settleTurn(outcome: TranscriptTurnOutcome, at = Date.now()): void {
    this.apply({ kind: 'turn_end', outcome, at });
  }

  beginReplay(at = Date.now()): void {
    this.apply({ kind: 'replay_start', at });
  }

  endReplay(at = Date.now()): void {
    this.apply({ kind: 'replay_end', at });
  }

  /**
   * Reset all slices to their initial state.
   */
  reset(): void {
    this.state = initialState();
  }

  /** All finalized, committed turns in chronological order. */
  get history(): readonly TranscriptTurn[] {
    return this.state.transcript.committed;
  }

  /** The in-flight turn, or null when the session is idle. */
  get activeTurn(): TranscriptTurn | null {
    return this.state.transcript.active;
  }

  /** Latest materialized session config (models / efforts / modes / commands). */
  get config(): SessionConfigState {
    return this.state.config;
  }

  /** Latest context-window usage, or null until the first usage_update arrives. */
  get usage(): SessionUsage | null {
    return this.state.usage;
  }

  /** Latest session title from session_info_update, or null. */
  get title(): string | null {
    return this.state.title;
  }

  get agents(): readonly AgentState[] {
    return this.state.agents;
  }

  get plan(): PlanState | null {
    return this.state.plan;
  }

  /**
   * Fold a finite iterable of SessionUpdates and return all four slices.
   *
   * The trailing active transcript turn (if any) is closed at EOF — there is
   * no stopReason available during replay. Config / usage / title are returned
   * as-of the last update seen.
   *
   * @param updates  An iterable of raw ACP SessionUpdate notifications.
   * @param deps     conversationId + optional EnrichHook.
   * @returns        { committed, active, config, usage, title }
   */
  static replay(updates: Iterable<ReplayEntry>, deps: AcpTranscriptParserDeps): ReplayResult {
    const parser = new AcpTranscriptParser(deps);
    let at = 0;

    parser.beginReplay(at);
    for (const entry of updates) {
      const update = 'sessionUpdate' in entry ? entry : entry.update;
      at = 'sessionUpdate' in entry ? at : (entry.at ?? entry.ts ?? at);
      parser.push(update, at);
      at += 1;
    }
    parser.endReplay(at);

    return {
      committed: [...parser.history],
      active: parser.activeTurn,
      config: parser.config,
      usage: parser.usage,
      title: parser.title,
      agents: [...parser.agents],
      plan: parser.plan,
    };
  }
}
