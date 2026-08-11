import React, { useState } from 'react';

type FlexCardEventEntry = {
  event: { name?: string; detail?: unknown; source?: string };
  timestamp: number;
};

export function FlexCardEventCard({ entry }: { entry: FlexCardEventEntry }) {
  const [expanded, setExpanded] = useState(false);
  const name = entry.event?.name || 'FlexCard event';
  const source = entry.event?.source || 'runtime';

  return (
    <div className={`ct-card${expanded ? ' ct-card--expanded' : ''}`}>
      <div className="ct-card__header" onClick={() => setExpanded(value => !value)}>
        <span className="ct-toggle-icon">{expanded ? '▾' : '▸'}</span>
        <span className="ct-badge ct-badge--flexcard-event">FC:Evt</span>
        <span className="ct-card__label">{name}</span>
        <span className="ct-card__time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="ct-card__path">{source}</div>
      {expanded && (
        <div className="ct-card__details">
          <div className="ct-section">
            <div className="ct-section__label">Event detail</div>
            <pre className="ct-pre">{JSON.stringify(entry.event?.detail, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
