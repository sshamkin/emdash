import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const chipsRow = style({
  display: 'flex',
  alignItems: 'center',
});

export const chip = style({
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  border: `1px solid ${vars.border}`,
  borderRadius: '6px',
  color: vars.fgMuted,
  fontSize: vars.typeBodyFontSize,
  userSelect: 'none',
  overflow: 'hidden',
});

export const chipExpandable = style({
  cursor: 'pointer',
  selectors: {
    '&:hover': { background: vars.bg3 },
  },
});

export const chipLabel = style({
  minWidth: 0,
  flex: 1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export const chipMono = style({
  fontFamily: vars.typeCodeFontFamily,
  fontSize: vars.typeCodeFontSize,
  fontWeight: vars.typeCodeFontWeight,
});

export const chipError = style({
  color: vars.fgError,
  borderColor: vars.fgError,
});

export const chipDot = style({
  flexShrink: 0,
  width: '6px',
  height: '6px',
  borderRadius: '50%',
});

export const chipDotRunning = style({
  background: vars.fg,
});

export const chipDotError = style({
  background: vars.fgError,
});

export const chipDotPermission = style({
  background: '#eab308',
});
