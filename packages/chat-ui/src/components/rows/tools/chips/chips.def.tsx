/**
 * Tool chips — a run of consecutive folded tool calls rendered as compact
 * boxes flowing left-to-right with wrapping, instead of one full-width row
 * per call:
 *
 *   [ $ pnpm test ]  [ Read cell.ts ]  [ Search quiesce ]  [ Monitor ]
 *   [ $ git status ]
 *
 * Clicking an expandable chip (execute) toggles its collapse state via the
 * ChatRoot `data-collapse-id` delegation; flatten then breaks the run around
 * it and the call renders as its full-width card with command + output.
 *
 * Measure and Render share one greedy row-layout (`chipsLayout`) computed
 * from measured label widths, and Render assigns each chip its measured
 * width explicitly — so the DOM can never wrap differently than measured.
 */

import { measureProseNaturalWidth } from '@components/rows/markdown/prose/layout';
import type { MeasureCtx, RenderCtx } from '@core/define';
import type { ProseBlock } from '@core/markdown/document';
import type { SegmentCtx } from '@core/units';
import { defineUnit } from '@core/units';
import { For, Show } from 'solid-js';
import type { ChatToolChip, ChatToolChips, ToolChipsItem, ToolNode } from '@/model';
import {
  chip as chipClass,
  chipDot,
  chipDotError,
  chipDotPermission,
  chipDotRunning,
  chipError,
  chipExpandable,
  chipLabel,
  chipMono,
  chipsRow,
} from './chips.css';
import { textShimmer } from '@styles/effects.css';

export type ChipsVars = {
  /** Fixed chip height (px), borders included. */
  chipH: number;
  /** Horizontal gap between chips in a row. */
  gapX: number;
  /** Vertical gap between wrapped rows. */
  gapY: number;
  /** Horizontal padding inside a chip. */
  padX: number;
  /** Width reserved by the status dot + its gap when present. */
  dotW: number;
  /** Upper bound on a single chip's width. */
  maxChipW: number;
  /** Chip border width per side. */
  border: number;
};

const CHIPS_VARS: ChipsVars = {
  chipH: 24,
  gapX: 6,
  gapY: 6,
  padX: 8,
  dotW: 11,
  maxChipW: 360,
  border: 1,
};

// ── Presenter ─────────────────────────────────────────────────────────────────

function firstLine(text: string): { line: string; truncated: boolean } {
  const lines = (text || '…').split('\n');
  return { line: lines[0], truncated: lines.length > 1 };
}

function chipFrom(item: ToolNode, ctx: SegmentCtx): ChatToolChip {
  const base: Pick<ChatToolChip, 'id' | 'status' | 'awaitingPermission'> = {
    id: item.id,
    status: 'status' in item ? item.status : 'done',
    awaitingPermission:
      'toolCallId' in item ? ctx.pendingToolCallIds().has(item.toolCallId) : false,
  };

  switch (item.kind) {
    case 'execute-tool-call': {
      if (item.inputSummary) return { ...base, label: item.inputSummary, expandable: true };
      const { line, truncated } = firstLine(item.command ?? item.title);
      return {
        ...base,
        label: `$ ${line}${truncated ? ' …' : ''}`,
        mono: true,
        expandable: true,
      };
    }
    case 'read-tool-call':
      return { ...base, label: item.title || `Read ${item.path ?? ''}` };
    case 'search-tool-call':
      return { ...base, label: `Search ${item.query}` };
    case 'mcp-tool-call':
      return { ...base, label: `MCP ${[item.server, item.tool].filter(Boolean).join('.')}` };
    case 'web-fetch-tool-call':
      return { ...base, label: `Fetch ${item.pageTitle ?? item.url}` };
    default:
      return {
        ...base,
        label:
          'name' in item && item.name
            ? `${item.name}${item.inputSummary ? ` ${item.inputSummary}` : ''}`
            : 'Tool',
      };
  }
}

export function chipsFromItem(item: ToolChipsItem, ctx: SegmentCtx): ChatToolChips {
  return {
    kind: 'tool-chips',
    id: item.id,
    chips: item.items.map((chipItem) => chipFrom(chipItem as ToolNode, ctx)),
  };
}

// ── Layout ────────────────────────────────────────────────────────────────────

function hasDot(chipData: ChatToolChip): boolean {
  return (
    chipData.status === 'running' || chipData.status === 'error' || !!chipData.awaitingPermission
  );
}

function chipWidth(chipData: ChatToolChip, ctx: MeasureCtx, vars: ChipsVars): number {
  const fonts = chipData.mono
    ? { ...ctx.theme.fonts, body: ctx.theme.fonts.code }
    : ctx.theme.fonts;
  const block: ProseBlock = {
    kind: 'prose',
    id: 'chip-width',
    variant: 'body',
    runs: [{ kind: 'text', text: chipData.label }],
  };
  const textW = Math.ceil(measureProseNaturalWidth(block, fonts));
  const w = 2 * vars.border + 2 * vars.padX + (hasDot(chipData) ? vars.dotW : 0) + textW;
  return Math.min(w, vars.maxChipW);
}

type ChipSlot = { chip: ChatToolChip; w: number };

function chipsLayout(
  data: ChatToolChips,
  ctx: MeasureCtx,
  vars: ChipsVars
): { rows: ChipSlot[][]; height: number } {
  const rows: ChipSlot[][] = [];
  let row: ChipSlot[] = [];
  let x = 0;
  for (const chipData of data.chips) {
    const w = Math.min(chipWidth(chipData, ctx, vars), ctx.width);
    const next = row.length === 0 ? w : x + vars.gapX + w;
    if (row.length > 0 && next > ctx.width) {
      rows.push(row);
      row = [{ chip: chipData, w }];
      x = w;
    } else {
      row.push({ chip: chipData, w });
      x = next;
    }
  }
  if (row.length > 0) rows.push(row);
  const height = rows.length * vars.chipH + Math.max(0, rows.length - 1) * vars.gapY;
  return { rows, height };
}

// ── Render ────────────────────────────────────────────────────────────────────

function ChipsUnitRender(props: { data: ChatToolChips; ctx: RenderCtx; vars: ChipsVars }) {
  const layout = () => {
    const ctx = props.ctx.measureCtx?.();
    if (!ctx) return { rows: [], height: props.vars.chipH } as ReturnType<typeof chipsLayout>;
    return chipsLayout(props.data, ctx, props.vars);
  };

  return (
    <div>
      <For each={layout().rows}>
        {(row, rowIndex) => (
          <div
            class={chipsRow}
            style={{
              gap: `${props.vars.gapX}px`,
              height: `${props.vars.chipH}px`,
              'margin-top': rowIndex() > 0 ? `${props.vars.gapY}px` : undefined,
            }}
          >
            <For each={row}>
              {(slot) => (
                <div
                  class={chipClass}
                  classList={{
                    [chipExpandable]: !!slot.chip.expandable,
                    [chipError]: slot.chip.status === 'error',
                  }}
                  style={{
                    width: `${slot.w}px`,
                    height: `${props.vars.chipH}px`,
                    'padding-left': `${props.vars.padX}px`,
                    'padding-right': `${props.vars.padX}px`,
                  }}
                  title={slot.chip.error ?? slot.chip.label}
                  {...(slot.chip.expandable
                    ? { 'data-collapse-id': slot.chip.id, role: 'button', 'aria-expanded': 'false' }
                    : {})}
                >
                  <Show when={hasDot(slot.chip)}>
                    <span
                      class={chipDot}
                      classList={{
                        [chipDotRunning]: slot.chip.status === 'running',
                        [chipDotError]: slot.chip.status === 'error',
                        [chipDotPermission]: !!slot.chip.awaitingPermission,
                      }}
                      aria-hidden="true"
                    />
                  </Show>
                  <span
                    class={chipLabel}
                    classList={{
                      [chipMono]: !!slot.chip.mono,
                      [textShimmer]: slot.chip.status === 'running',
                    }}
                  >
                    {slot.chip.label}
                  </span>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

// ── UnitDef ───────────────────────────────────────────────────────────────────

export const toolChipsUnitDef = defineUnit<ChatToolChips, ChipsVars>({
  kind: 'tool-chips',
  margin: { top: 4, bottom: 4 },
  vars: CHIPS_VARS,

  estimate(data, ctx, vars): number {
    // O(1): assume an average chip footprint instead of measuring labels.
    // Count synchronization estimates with width 0 — assume a typical content
    // column there instead of degrading to one chip per row.
    const width = ctx.width > 0 ? ctx.width : 720;
    const approxChipW = 180 + vars.gapX;
    const perRow = Math.max(1, Math.floor(width / approxChipW));
    const rows = Math.max(1, Math.ceil(data.chips.length / perRow));
    return rows * vars.chipH + (rows - 1) * vars.gapY;
  },

  measure(data, ctx, vars): number {
    return chipsLayout(data, ctx, vars).height;
  },

  Render: ChipsUnitRender,
});
