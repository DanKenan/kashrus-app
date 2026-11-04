import type React from 'react';

export function personAvatar(email: string): React.CSSProperties {
  const palette = ['var(--task-avatar-teal)', 'var(--task-avatar-slate)', 'var(--task-avatar-plum)', 'var(--task-avatar-green)', 'var(--task-avatar-amber)'];
  const index = Array.from(email.toLowerCase()).reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length;
  return { background: palette[index], color: 'var(--task-avatar-letter)' };
}
