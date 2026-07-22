/**
 * Tool-chip strip stories — runs of folded tool calls rendered as compact
 * left-to-right chips; clicking an execute chip expands the full card.
 */

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import type { TranscriptTurn } from '@/model';
import { ChatHost } from '@/stories/_harness/chat-host';

const meta: Meta = {
  title: 'Rows/Tools/Chips',
  component: ChatHost,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof ChatHost>;

function chipsTurn(): TranscriptTurn {
  return {
    id: 'chips-turn',
    seq: 0,
    initiator: 'agent',
    items: [
      {
        kind: 'message',
        id: 'chips-m1',
        seq: 0,
        role: 'assistant',
        text: 'Checking the working tree before the release build.',
      },
      {
        kind: 'execute-tool-call',
        id: 'chips-e1',
        seq: 1,
        toolCallId: 'e1',
        title: 'git status --short',
        command: 'git status --short',
        status: 'done',
      },
      {
        kind: 'execute-tool-call',
        id: 'chips-e2',
        seq: 2,
        toolCallId: 'e2',
        title: 'pnpm run build',
        command: 'pnpm run build',
        status: 'done',
        outputText: 'NX   Successfully ran target build for 9 projects',
      },
      {
        kind: 'read-tool-call',
        id: 'chips-r1',
        seq: 3,
        toolCallId: 'r1',
        title: 'Read cell.ts',
        path: 'packages/runtime/src/acp-agents/session/cell.ts',
        status: 'done',
      },
      {
        kind: 'search-tool-call',
        id: 'chips-s1',
        seq: 4,
        toolCallId: 's1',
        title: 'quiesce',
        query: 'quiesce',
        status: 'done',
      },
      {
        kind: 'unknown-tool-call',
        id: 'chips-u1',
        seq: 5,
        toolCallId: 'u1',
        title: 'Monitor',
        name: 'Monitor',
        toolKind: 'other',
        status: 'running',
      },
      {
        kind: 'execute-tool-call',
        id: 'chips-e3',
        seq: 6,
        toolCallId: 'e3',
        title: 'long command',
        command:
          "sed -n '/upload_with_null_grant_element_returns_400/,/^    }$/p' platform/services/content-storage/src/api/grants.rs",
        status: 'error',
        outputText: 'sed: unmatched pattern',
      },
      {
        kind: 'message',
        id: 'chips-m2',
        seq: 7,
        role: 'assistant',
        text: 'Build is green; one probe command failed, expand it for the output.',
      },
    ] as TranscriptTurn['items'],
  };
}

export const FoldedRun: Story = {
  render: () => <ChatHost items={[chipsTurn()]} height={360} />,
};

export const WrappingNarrow: Story = {
  render: () => <ChatHost items={[chipsTurn()]} height={420} width={560} />,
};
