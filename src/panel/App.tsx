import React, { Suspense, useState } from 'react';
import { ExtProvider, useExt } from './context/ExtContext';
import { visibleTabs } from './tabs/registry';

function Header() {
  const { orgDomain, isConnected, availableOrgs, originTabId, switchOrg, refreshOrgs } = useExt();

  const handleOrgChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const tabId = parseInt(e.target.value, 10);
    if (!isNaN(tabId)) void switchOrg(tabId);
  };

  return (
    <header className="header">
      <div className="header-left">
        <span className="header-logo">◈</span>
        <span className="header-title">OmniStudio Tools</span>
      </div>
      <div className="header-right" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {availableOrgs.length > 1 ? (
          <>
            <select
              className="header-org-select"
              value={originTabId ?? ''}
              onChange={handleOrgChange}
              title="Switch Salesforce org"
            >
              {availableOrgs.map(org => (
                <option key={org.tabId} value={org.tabId}>
                  {org.orgDomain}
                </option>
              ))}
            </select>
            <button
              className="header-org-refresh"
              onClick={() => void refreshOrgs()}
              title="Refresh org list"
            >
              ↻
            </button>
          </>
        ) : (
          <span
            className={`org-badge ${isConnected ? 'org-badge--connected' : 'org-badge--disconnected'}`}
            title={orgDomain ?? undefined}
          >
            {orgDomain ?? 'Not connected'}
          </span>
        )}
      </div>
    </header>
  );
}

function FeatureNav({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  const tabs = visibleTabs();
  return (
    <nav className="feature-nav">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`feature-tab${active === tab.id ? ' feature-tab--active' : ''}`}
          onClick={() => onSelect(tab.id)}
        >
          <span className="feature-tab__icon">{tab.icon}</span>
          <span className="feature-tab__label">{tab.label}</span>
          {tab.pill && <span className="feature-tab__pill">{tab.pill}</span>}
        </button>
      ))}
    </nav>
  );
}

function TabContent({ activeId }: { activeId: string }) {
  const { isLoading, isConnected } = useExt();

  if (isLoading) {
    return <div className="auth-error"><div className="auth-error__icon">⋯</div><div>Connecting…</div></div>;
  }

  if (!isConnected) {
    return (
      <div className="auth-error">
        <div className="auth-error__icon">⚠</div>
        <div className="auth-error__text">
          <strong>Not on a Salesforce org</strong>
          <p>Navigate to a Salesforce org tab and reopen this panel.</p>
          <p style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
            Check the browser console (DevTools → Extensions → OmniStudio Tools panel) for
            <code> [OmniTools]</code> debug lines to diagnose the connection.
          </p>
        </div>
      </div>
    );
  }

  const tab = visibleTabs().find(t => t.id === activeId);
  if (!tab) return null;
  const Component = tab.component as React.ComponentType;

  return (
    <Suspense fallback={<div className="auth-error">Loading…</div>}>
      <Component />
    </Suspense>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('datapack');

  return (
    <ExtProvider>
      <AppInner activeTab={activeTab} setActiveTab={setActiveTab} />
    </ExtProvider>
  );
}

function AppInner({ activeTab, setActiveTab }: { activeTab: string; setActiveTab: (id: string) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header />
      <FeatureNav active={activeTab} onSelect={setActiveTab} />
      <div className="feature-panel" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <TabContent activeId={activeTab} />
      </div>
    </div>
  );
}
