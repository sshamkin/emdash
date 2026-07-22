import { ROW_H } from '@components/engine/row-metrics';
import { CollapsibleCard } from '@components/primitives/CollapsibleCard';
import { IconTerminal } from '@components/primitives/icons';
import { measureProseNaturalWidth } from '@components/rows/markdown/prose/layout';
import type { MeasureCtx, RenderCtx } from '@core/define';
import type { ProseBlock } from '@core/markdown/document';
import { defineUnit } from '@core/units';
import { Show, createMemo } from 'solid-js';
import type { ChatExecute } from '@/model';
import { ExecuteBody, type ExecuteDisplayLine } from './Execute';

export { executeFromItem } from './execute.presenter';

export type ExecuteVars = {
  /** Fixed height (px) of the header row. */
  rowH: number;
  /** Border width (px) on each side of the card. */
  border: number;
  /** Horizontal padding on each command line. */
  linePadX: number;
  /** Width and height of the thin native scrollbar. */
  scrollbarSize: number;
  /** Visual separation between command text and the horizontal scrollbar. */
  scrollbarGap: number;
  /** Max lines shown / scrollable in the expanded state. */
  expandedMaxLines: number;
};

const EXECUTE_VARS: ExecuteVars = {
  rowH: ROW_H,
  border: 1,
  linePadX: 12,
  scrollbarSize: 8,
  scrollbarGap: 3,
  expandedMaxLines: 16,
};

/** 3 borders: top card edge + header-separator + bottom card edge. */
function chromeY(vars: ExecuteVars): number {
  return 3 * vars.border;
}

/** Folded card: a single header row framed by the top and bottom card edges. */
function foldedH(vars: ExecuteVars): number {
  return vars.rowH + 2 * vars.border;
}

function commandLines(command: string): string[] {
  return (command || '…').split('\n');
}

/**
 * Folded cards surface the command itself (or the provider's summary) in the
 * header so the one-line state stays informative; expanded cards fall back to
 * the generic label because the body shows the full command.
 */
function headerLabel(item: ChatExecute, expanded: boolean): string {
  if (item.inputSummary) return item.inputSummary;
  if (expanded) return 'Execute';
  const [first, ...rest] = commandLines(item.command);
  return rest.length > 0 ? `$ ${first} …` : `$ ${first}`;
}

function outputLines(outputText: string | undefined): string[] {
  if (!outputText) return [];
  return outputText.replace(/\r\n/g, '\n').split('\n');
}

function executeLines(item: ChatExecute): ExecuteDisplayLine[] {
  const command = commandLines(item.command).map(
    (line, index): ExecuteDisplayLine => ({
      kind: 'command',
      text: `${index === 0 ? '$' : ' '} ${line}`,
    })
  );
  const output = outputLines(item.outputText).map(
    (line): ExecuteDisplayLine => ({ kind: 'output', text: line })
  );
  return output.length > 0 ? [...command, { kind: 'spacer', text: '' }, ...output] : command;
}

function executeBodyH(
  lines: ExecuteDisplayLine[],
  codeLineH: number,
  vars: ExecuteVars
): { bodyH: number; contentH: number } {
  const contentH = lines.length * codeLineH;
  const cap = vars.expandedMaxLines * codeLineH;
  const bodyH = Math.min(contentH, cap);
  return { bodyH, contentH };
}

function hasHorizontalOverflow(
  lines: ExecuteDisplayLine[],
  ctx: MeasureCtx,
  vars: ExecuteVars,
  verticalScrollbarW: number
): boolean {
  const availableWidth = ctx.width - 2 * vars.border - 2 * vars.linePadX - verticalScrollbarW;
  const codeFonts = { ...ctx.theme.fonts, body: ctx.theme.fonts.code };

  return lines.some((line) => {
    const block: ProseBlock = {
      kind: 'prose',
      id: 'execute-width',
      variant: 'body',
      runs: [{ kind: 'text', text: line.text }],
    };
    return measureProseNaturalWidth(block, codeFonts) > availableWidth;
  });
}

function scrollbarSpace(
  lines: ExecuteDisplayLine[],
  ctx: MeasureCtx,
  vars: ExecuteVars,
  hasVerticalOverflow: boolean
): number {
  const verticalScrollbarW = hasVerticalOverflow ? vars.scrollbarSize : 0;
  return hasHorizontalOverflow(lines, ctx, vars, verticalScrollbarW)
    ? vars.scrollbarGap + vars.scrollbarSize
    : 0;
}

function executeUnitH(item: ChatExecute, ctx: MeasureCtx, vars: ExecuteVars): number {
  if (!ctx.expanded(item.id)) return foldedH(vars);
  const lines = executeLines(item);
  const { bodyH, contentH } = executeBodyH(lines, ctx.theme.fonts.code.lineHeight, vars);
  const hasVerticalOverflow = contentH > bodyH;
  return vars.rowH + bodyH + scrollbarSpace(lines, ctx, vars, hasVerticalOverflow) + chromeY(vars);
}

function ExecuteUnitRender(props: { data: ChatExecute; ctx: RenderCtx; vars: ExecuteVars }) {
  const mCtx = () => props.ctx.measureCtx?.();
  // Inverted semantics: stored "collapsed" bool = "expanded".
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.id);

  const lines = createMemo(() => executeLines(props.data));
  const codeLineH = createMemo(() => mCtx()?.theme.fonts.code.lineHeight ?? 0);
  const bodyGeometry = createMemo(() => {
    const lineH = codeLineH();
    if (!lineH || !isExpanded()) return { bodyH: 0, contentH: 0 };
    return executeBodyH(lines(), lineH, props.vars);
  });
  const showScrollbar = createMemo(() => {
    const ctx = mCtx();
    if (!ctx || !isExpanded()) return false;
    const geometry = bodyGeometry();
    const hasVerticalOverflow = geometry.contentH > geometry.bodyH;
    const verticalScrollbarW = hasVerticalOverflow ? props.vars.scrollbarSize : 0;
    return hasHorizontalOverflow(lines(), ctx, props.vars, verticalScrollbarW);
  });

  const totalH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return foldedH(props.vars);
    return executeUnitH(props.data, ctx, props.vars);
  });

  return (
    <CollapsibleCard
      id={props.data.id}
      ctx={props.ctx}
      height={totalH()}
      headerH={props.vars.rowH}
      expanded={isExpanded()}
      active={props.data.status === 'running' && !props.data.awaitingPermission}
      error={props.data.status === 'error'}
      errorTitle={props.data.error}
      awaitingPermission={props.data.awaitingPermission}
      icon={<IconTerminal />}
      header={headerLabel(props.data, isExpanded())}
      bodyVisible={isExpanded()}
    >
      <Show when={isExpanded() && codeLineH() > 0}>
        <ExecuteBody
          item={props.data}
          lines={lines()}
          bodyH={bodyGeometry().bodyH}
          contentH={bodyGeometry().contentH}
          codeLineH={codeLineH()}
          linePadX={props.vars.linePadX}
          scrollbarH={showScrollbar() ? props.vars.scrollbarSize : 0}
          scrollbarGap={showScrollbar() ? props.vars.scrollbarGap : 0}
          expanded={isExpanded()}
        />
      </Show>
    </CollapsibleCard>
  );
}

export const executeUnitDef = defineUnit<ChatExecute, ExecuteVars>({
  kind: 'execute',
  margin: { top: 2, bottom: 4 },
  vars: EXECUTE_VARS,

  estimate(item, ctx, vars): number {
    if (!ctx.expanded(item.id)) return foldedH(vars);
    const lines = executeLines(item);
    // Approximate code line height — use a fixed fallback of 20px for estimate.
    const approxLineH = 20;
    const { bodyH } = executeBodyH(lines, approxLineH, vars);
    return vars.rowH + bodyH + scrollbarSpace(lines, ctx, vars, false) + chromeY(vars);
  },

  measure(item, ctx, vars): number {
    return executeUnitH(item, ctx, vars);
  },

  Render: ExecuteUnitRender,
});
