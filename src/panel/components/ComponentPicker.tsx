import React from 'react';
import type { ComponentInfo } from '../../types/debugger';

interface Props {
  components: ComponentInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ComponentPicker({ components, selectedId, onSelect }: Props) {
  if (components.length === 0) return null;

  return (
    <div className="dbg-comp-select-row">
      <label className="dbg-comp-select-label" htmlFor="dbg-comp-select">
        Component
      </label>
      <select
        id="dbg-comp-select"
        className="dbg-comp-select"
        value={selectedId ?? ''}
        onChange={e => { if (e.target.value) onSelect(e.target.value); }}
      >
        <option value="" disabled>
          {components.length} components — select one
        </option>
        {components.map(c => (
          <option key={c.id} value={c.id}>
            {c.kind === 'OmniScript' ? 'OS' : c.kind === 'FlexCard' ? 'FC' : '?'}
            {' · '}
            {c.label || c.tag}
          </option>
        ))}
      </select>
    </div>
  );
}
