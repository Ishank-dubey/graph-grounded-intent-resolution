import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

export interface OrgInfo {
  tabId: number;
  orgDomain: string;
  orgUrl: string;
  label: string;
}

interface ExtContextValue {
  originTabId: number | null;
  orgDomain: string | null;
  isConnected: boolean;
  isLoading: boolean;
  availableOrgs: OrgInfo[];
  switchOrg: (tabId: number) => Promise<void>;
  refreshOrgs: () => Promise<void>;
}

const ExtContext = createContext<ExtContextValue>({
  originTabId: null,
  orgDomain: null,
  isConnected: false,
  isLoading: true,
  availableOrgs: [],
  switchOrg: async () => {},
  refreshOrgs: async () => {},
});

export function useExt() {
  return useContext(ExtContext);
}

export function ExtProvider({ children }: { children: React.ReactNode }) {
  const [originTabId, setOriginTabId] = useState<number | null>(null);
  const [orgDomain, setOrgDomain] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [availableOrgs, setAvailableOrgs] = useState<OrgInfo[]>([]);

  // ── helpers ────────────────────────────────────────────────────────────────

  async function fetchAuth(tabId: number): Promise<void> {
    type AuthResponse =
      | { success: true; data: { orgUrl: string; orgDomain: string } }
      | { success: false; error: string };
    const resp = await chrome.runtime.sendMessage<unknown, AuthResponse>({ type: 'GET_AUTH', tabId });
    console.log('[OmniTools] GET_AUTH tabId:', tabId, '→', resp);
    if (resp.success) {
      setOrgDomain(resp.data.orgDomain);
      setIsConnected(true);
    } else {
      setOrgDomain(null);
      setIsConnected(false);
      // ── Auth failed — dump diagnostic info ──────────────────────────────
      try {
        // 1. What URL does this tab actually have?
        const tab = await chrome.tabs.get(tabId);
        console.log('[OmniTools] DIAG tab URL:', tab.url, '| title:', tab.title);
      } catch (e) {
        console.warn('[OmniTools] DIAG chrome.tabs.get failed (tab may be closed):', e);
      }
      try {
        // 2. What sid cookies does the extension actually have access to?
        const sidCookies = await chrome.cookies.getAll({ name: 'sid' });
        console.log('[OmniTools] DIAG all "sid" cookies visible to extension:',
          sidCookies.map(c => ({ domain: c.domain, secure: c.secure, session: c.session }))
        );
        // 3. Also dump any cookie whose name starts with 'sid' (some orgs use sid=xxx or similar)
        const allCookies = await chrome.cookies.getAll({});
        const sfCookies = allCookies.filter(c =>
          c.domain.includes('salesforce') || c.domain.includes('force.com')
        );
        console.log('[OmniTools] DIAG all cookies on salesforce/force domains:',
          sfCookies.map(c => ({ name: c.name, domain: c.domain, session: c.session }))
        );
      } catch (e) {
        console.warn('[OmniTools] DIAG cookie enumeration failed:', e);
      }
    }
  }

  async function fetchAvailableOrgs(): Promise<OrgInfo[]> {
    try {
      type OrgsResponse =
        | { success: true; data: OrgInfo[] }
        | { success: false; error: string };
      const resp = await chrome.runtime.sendMessage<unknown, OrgsResponse>({ type: 'LIST_SF_ORGS' });
      console.log('[OmniTools] LIST_SF_ORGS →', resp);
      if (resp.success) {
        setAvailableOrgs(resp.data);
        return resp.data;
      }
      // Also log all normal tabs for diagnosis
      const allTabs = await chrome.tabs.query({ windowType: 'normal' });
      console.log('[OmniTools] DIAG all normal tabs:',
        allTabs.map(t => ({ id: t.id, url: t.url?.substring(0, 80) }))
      );
    } catch (e) {
      console.warn('[OmniTools] LIST_SF_ORGS error:', e);
    }
    return [];
  }

  // ── initial mount ──────────────────────────────────────────────────────────

  useEffect(() => {
    void (async () => {
      try {
        type OriginTabResponse =
          | { success: true; data: { tabId: number | null } }
          | { success: false; error: string };

        const originResp = await chrome.runtime.sendMessage<unknown, OriginTabResponse>(
          { type: 'GET_ORIGIN_TAB' }
        );
        console.log('[OmniTools] GET_ORIGIN_TAB →', originResp);

        let tabId: number | null = null;

        if (originResp.success && originResp.data.tabId !== null) {
          tabId = originResp.data.tabId;
        } else {
          // Fallback: find the most-recently-active Salesforce tab
          const allTabs = await chrome.tabs.query({ windowType: 'normal' });
          console.log(
            '[OmniTools] Fallback: SF tabs found:',
            allTabs
              .filter(t => t.url && (t.url.includes('.salesforce.com') || t.url.includes('.force.com')))
              .map(t => ({ id: t.id, url: t.url, lastAccessed: t.lastAccessed }))
          );
          const sfTab = allTabs
            .filter(t => t.url && (t.url.includes('.salesforce.com') || t.url.includes('.force.com')))
            .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
          if (sfTab?.id) {
            tabId = sfTab.id;
            await chrome.runtime.sendMessage({ type: 'SET_ORIGIN_TAB', tabId }).catch(() => {});
            console.log('[OmniTools] Fallback SET_ORIGIN_TAB tabId:', tabId, 'url:', sfTab.url);
          }
        }

        console.log('[OmniTools] Resolved originTabId:', tabId);
        setOriginTabId(tabId);

        if (!tabId) {
          setIsLoading(false);
          return;
        }

        await fetchAuth(tabId);
        await fetchAvailableOrgs();
      } catch (e) {
        console.error('[OmniTools] Init error:', e);
      } finally {
        setIsLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── retry when originTabId is null (SW restart race) ──────────────────────

  useEffect(() => {
    if (originTabId !== null) return;

    const retryTimer = setInterval(async () => {
      try {
        type OriginTabResponse =
          | { success: true; data: { tabId: number | null } }
          | { success: false; error: string };
        const r = await chrome.runtime.sendMessage<unknown, OriginTabResponse>(
          { type: 'GET_ORIGIN_TAB' }
        );
        let tid: number | null = null;
        if (r.success && r.data.tabId !== null) {
          tid = r.data.tabId;
        } else {
          const allTabs = await chrome.tabs.query({ windowType: 'normal' });
          const sfTab = allTabs
            .filter(t => t.url && (t.url.includes('.salesforce.com') || t.url.includes('.force.com')))
            .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
          if (sfTab?.id) {
            tid = sfTab.id;
            await chrome.runtime.sendMessage({ type: 'SET_ORIGIN_TAB', tabId: tid }).catch(() => {});
          }
        }
        if (tid) {
          setOriginTabId(tid);
          await fetchAuth(tid);
          await fetchAvailableOrgs();
        }
      } catch (_) {}
    }, 2000);

    return () => clearInterval(retryTimer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originTabId]);

  // ── org switcher ──────────────────────────────────────────────────────────

  const switchOrg = useCallback(async (tabId: number) => {
    console.log('[OmniTools] switchOrg → tabId:', tabId);
    setIsConnected(false);
    setOrgDomain(null);
    setOriginTabId(tabId);
    try {
      await chrome.runtime.sendMessage({ type: 'SET_ORIGIN_TAB', tabId });
      await fetchAuth(tabId);
    } catch (e) {
      console.error('[OmniTools] switchOrg error:', e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshOrgs = useCallback(async () => {
    // Re-query the background for the currently active tab.
    // background.ts tracks tab switches via chrome.tabs.onActivated, so
    // GET_ORIGIN_TAB already reflects the tab the user is looking at.
    // Without this step the panel stays locked on the tab that was active
    // when the side panel was first opened.
    try {
      type OriginTabResponse =
        | { success: true; data: { tabId: number | null } }
        | { success: false; error: string };

      let freshTabId: number | null = null;

      const originResp = await chrome.runtime.sendMessage<unknown, OriginTabResponse>(
        { type: 'GET_ORIGIN_TAB' }
      );
      if (originResp.success && originResp.data.tabId !== null) {
        freshTabId = originResp.data.tabId;
      } else {
        // Fallback: find the most-recently-active Salesforce tab ourselves
        const allTabs = await chrome.tabs.query({ windowType: 'normal' });
        const sfTab = allTabs
          .filter(t => t.url && (t.url.includes('.salesforce.com') || t.url.includes('.force.com')))
          .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
        if (sfTab?.id) {
          freshTabId = sfTab.id;
          await chrome.runtime.sendMessage({ type: 'SET_ORIGIN_TAB', tabId: freshTabId }).catch(() => {});
        }
      }

      if (freshTabId !== null) {
        // Always update panel state — even if the tab ID is the same, re-running
        // fetchAuth refreshes the org domain and connection status cleanly.
        setOriginTabId(freshTabId);
        setIsConnected(false);
        setOrgDomain(null);
        await fetchAuth(freshTabId);
      }
    } catch (e) {
      console.warn('[OmniTools] refreshOrgs: tab re-detect failed:', e);
    }

    await fetchAvailableOrgs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ExtContext.Provider
      value={{ originTabId, orgDomain, isConnected, isLoading, availableOrgs, switchOrg, refreshOrgs }}
    >
      {children}
    </ExtContext.Provider>
  );
}
