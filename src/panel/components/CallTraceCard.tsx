import React, { useState } from 'react';

interface CallTraceEntry {
  callTrace: unknown;
  timestamp: number;
}

export function CallTraceCard({ entry }: { entry: CallTraceEntry }) {
  const [expanded, setExpanded] = useState(false);

  const ct = entry.callTrace as {
    params?: { sClassName?: string; sMethodName?: string; input?: unknown; options?: unknown };
    response?: unknown;
    element?: { label?: string; type?: string; elementType?: string };
  };

  const time = new Date(entry.timestamp).toLocaleTimeString();
  const label = ct.element?.label || ct.params?.sClassName || ct.params?.sMethodName || 'Unknown';
  const elementType = ct.element?.type || ct.element?.elementType || '';

  // Diagnostic entries emitted by the hook when it first attaches to a component.
  // Render as a dimmed, non-interactive banner so they're visible but unobtrusive.
  if (elementType === 'hook-diagnostic') {
    return (
      <div className="ct-card ct-card--diagnostic">
        <div className="ct-card__header">
          <span className="ct-toggle-icon" style={{ opacity: 0 }}>▸</span>
          <span className="ct-badge ct-badge--diagnostic">◎</span>
          <span className="ct-card__label" style={{ fontStyle: 'italic', opacity: 0.7 }}>{label}</span>
          <span className="ct-card__time">{time}</span>
        </div>
      </div>
    );
  }

  const className = ct.params?.sClassName || '';
  const methodName = ct.params?.sMethodName || '';
  const isError = (ct.response as Record<string, unknown>)?.error === true ||
                  (ct.response as Record<string, unknown>)?.error === 'ERROR';

  let typeBadge = '';
  if (elementType === 'integration-procedure-action') typeBadge = 'IP';
  else if (elementType === 'dataraptor-action') typeBadge = 'DataRaptor';
  else if (elementType === 'rest') typeBadge = 'REST';
  else if (elementType === 'apex') typeBadge = 'Apex';
  else if (elementType === 'flexcard-datasource') typeBadge = 'FC:XHR';
  else typeBadge = elementType || 'Apex';
  const typeClass = elementType || 'apex';

  return (
    <div className={`ct-card${isError ? ' ct-card--error' : ''}${expanded ? ' ct-card--expanded' : ''}`}>
      <div className="ct-card__header" onClick={() => setExpanded(e => !e)}>
        <span className="ct-toggle-icon">{expanded ? '▾' : '▸'}</span>
        <span className={`ct-badge ct-badge--${typeClass}`}>{typeBadge}</span>
        <span className="ct-card__label">{label}</span>
        <span className="ct-card__time">{time}</span>
        {isError && <span className="ct-card__error-flag">✕ Error</span>}
      </div>
      <div className="ct-card__path">{className}{methodName ? ` · ${methodName}` : ''}</div>
      {expanded && (
        <div className="ct-card__details">
          <div className="ct-section">
            <div className="ct-section__label">Request</div>
            <pre className="ct-pre">
              {JSON.stringify({ input: ct.params?.input, options: ct.params?.options }, null, 2)}
            </pre>
          </div>
          <div className="ct-section">
            <div className="ct-section__label">Response</div>
            <pre className={`ct-pre${isError ? ' ct-pre--error' : ''}`}>
              {JSON.stringify(ct.response, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
