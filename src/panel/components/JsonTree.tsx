import React, { useState } from 'react';

function Leaf({ keyName, display, cls, depth }: { keyName: string; display: string; cls: string; depth: number }) {
  const [flash, setFlash] = useState(false);
  const handleClick = keyName ? () => {
    void navigator.clipboard.writeText(`%${keyName}%`);
    setFlash(true);
    setTimeout(() => setFlash(false), 800);
  } : undefined;

  return (
    <div
      className="dj-row"
      style={{ paddingLeft: `${14 + depth * 16}px`, cursor: keyName ? 'pointer' : undefined, background: flash ? 'rgba(134,239,172,0.15)' : undefined }}
      title={keyName ? 'Click to copy merge field' : undefined}
      onClick={handleClick}
    >
      {keyName && <><span className="dj-key">{keyName}</span><span className="dj-sep">: </span></>}
      <span className={cls}>{display}</span>
    </div>
  );
}

function Collapsible({ keyName, value, depth }: { keyName: string; value: unknown; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const summary = Array.isArray(value)
    ? `[${(value as unknown[]).length}]`
    : `{${Object.keys(value as object).length}}`;

  return (
    <div>
      <div
        className="dj-row dj-row--collapsible"
        style={{ paddingLeft: `${14 + depth * 16}px`, cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        <span className="dj-toggle">{expanded ? '▾' : '▸'}</span>
        {keyName && <><span className="dj-key">{keyName}</span><span className="dj-sep">: </span></>}
        <span className="dj-type">{summary}</span>
      </div>
      {expanded && (
        <div className="dj-children">
          {Array.isArray(value)
            ? (value as unknown[]).map((item, i) => <JsonNode key={i} keyName={String(i)} value={item} depth={depth + 1} />)
            : Object.entries(value as Record<string, unknown>).map(([k, v]) => <JsonNode key={k} keyName={k} value={v} depth={depth + 1} />)
          }
        </div>
      )}
    </div>
  );
}

function JsonNode({ keyName, value, depth }: { keyName: string; value: unknown; depth: number }) {
  if (value === null || value === undefined) return <Leaf keyName={keyName} display="null" cls="dj-null" depth={depth} />;
  if (typeof value === 'boolean') return <Leaf keyName={keyName} display={String(value)} cls="dj-bool" depth={depth} />;
  if (typeof value === 'number') return <Leaf keyName={keyName} display={String(value)} cls="dj-number" depth={depth} />;
  if (typeof value === 'string') {
    const display = value.length > 120 ? value.slice(0, 120) + '…' : value;
    return <Leaf keyName={keyName} display={`"${display}"`} cls="dj-string" depth={depth} />;
  }
  if (Array.isArray(value) || typeof value === 'object') {
    return <Collapsible keyName={keyName} value={value} depth={depth} />;
  }
  return null;
}

export function JsonTree({ data }: { data: unknown }) {
  if (typeof data !== 'object' || data === null) {
    return <div className="dj-row" style={{ padding: '14px' }}><span className="dj-string">"{String(data)}"</span></div>;
  }
  return (
    <div className="dj-tree">
      {Array.isArray(data)
        ? (data as unknown[]).map((item, i) => <JsonNode key={i} keyName={String(i)} value={item} depth={0} />)
        : Object.entries(data as Record<string, unknown>).map(([k, v]) => <JsonNode key={k} keyName={k} value={v} depth={0} />)
      }
    </div>
  );
}
