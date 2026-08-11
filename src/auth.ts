import type { OrgInfo } from './types/bundle.js';

export interface OrgSession {
  orgUrl: string;
  orgDomain: string;
  sid: string;
  apiVersion: string;
}

export function isOrgUrl(url: string): boolean {
  return /[./](salesforce|force)\.com(\/|$)/.test(url);
}

/**
 * Derive the API/cookie domain from a browser tab URL.
 *
 * Handles the common Salesforce URL patterns:
 *   xxx.lightning.force.com               → xxx.my.salesforce.com   (standard orgs)
 *   xxx.develop.lightning.force.com       → xxx.develop.my.salesforce.com
 *   xxx.my.salesforce.com                 → same
 *   xxx.force.com                         → xxx.my.salesforce.com
 *   xxx.salesforce.com                    → xxx.my.salesforce.com  (adds my. if not present)
 */
function deriveApiDomain(hostname: string): string {
  // Standard Lightning UI on salesforce.com:
  //   xxx.lightning.force.com → xxx.my.salesforce.com
  // Also handles Enhanced Domains like xxx.develop.lightning.force.com → xxx.develop.my.salesforce.com
  if (hostname.endsWith('.lightning.force.com')) {
    const org = hostname.replace('.lightning.force.com', '');
    return `${org}.my.salesforce.com`;
  }

  // Enhanced or non-standard Salesforce domains with an environment segment.
  // Pattern: {left}.lightning.{env}.force.com → {left}.my.{env}.salesforce.com
  // Note: this regex requires something between '.lightning.' and '.force.com' so it never
  // matches standard xxx.lightning.force.com (which is caught by the first branch above).
  const lightningMidMatch = hostname.match(/^(.+)\.lightning\.(.+)\.force\.com$/);
  if (lightningMidMatch) {
    return `${lightningMidMatch[1]}.my.${lightningMidMatch[2]}.salesforce.com`;
  }

  // Already a my.salesforce.com domain
  if (hostname.endsWith('.my.salesforce.com')) {
    return hostname;
  }
  // Other *.force.com → swap suffix
  if (hostname.endsWith('.force.com')) {
    const org = hostname.replace('.force.com', '');
    return `${org}.my.salesforce.com`;
  }
  // *.salesforce.com — add my. if not present
  if (hostname.endsWith('.salesforce.com')) {
    const parts = hostname.split('.');
    // parts: ['xxx', 'salesforce', 'com'] or ['xxx', 'my', 'salesforce', 'com']
    if (parts[1] === 'my') {
      return hostname; // already has my.
    }
    // Insert 'my' after the first segment
    return `${parts[0]}.my.salesforce.com`;
  }
  // Fallback: return as-is
  return hostname;
}

/**
 * Return an OrgSession directly from an org domain string (no tab lookup).
 * Used when the caller already knows which org to target (e.g. the DataPack org picker).
 */
export async function getSessionForDomain(orgDomain: string): Promise<OrgSession | null> {
  try {
    const cookie = await chrome.cookies.get({ url: `https://${orgDomain}`, name: 'sid' });
    if (cookie) {
      return { orgUrl: `https://${orgDomain}`, orgDomain, sid: cookie.value, apiVersion: 'v62.0' };
    }
  } catch (_) {}
  return null;
}

/**
 * Enumerate all normal browser tabs that are open on a Salesforce URL and have
 * an active `sid` cookie.  Deduplicates by API domain so that e.g. the Lightning
 * and Visualforce hosts of the same org appear only once.
 */
export async function listAllOrgSessions(): Promise<OrgInfo[]> {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const sfTabs = tabs.filter(t => t.url && isOrgUrl(t.url));
  const results: OrgInfo[] = [];
  const seen = new Set<string>();

  for (const tab of sfTabs) {
    if (!tab.url || !tab.id) continue;
    try {
      const hostname = new URL(tab.url).hostname;
      const apiDomain = deriveApiDomain(hostname);

      // Try the derived API domain first, then fall back to the original hostname
      // This fallback accommodates non-standard domains whose cookie domain
      // differs from the derived API hostname.
      const domainsToTry = [apiDomain];
      if (hostname !== apiDomain) domainsToTry.push(hostname);

      let found = false;
      for (const domain of domainsToTry) {
        if (seen.has(domain)) { found = true; break; }
        let cookie: chrome.cookies.Cookie | null = null;
        try {
          cookie = await chrome.cookies.get({ url: `https://${domain}`, name: 'sid' });
        } catch (_) {}
        if (cookie) {
          seen.add(domain);
          results.push({
            tabId: tab.id,
            orgDomain: domain,
            orgUrl: `https://${domain}`,
            label: tab.title ?? domain,
          });
          found = true;
          break;
        }
      }
      if (!found) {
        // Mark any derived domain as seen so we don't re-process the same org
        seen.add(apiDomain);
      }
    } catch (_) {}
  }
  return results;
}

export async function getSessionForTab(tabId: number): Promise<OrgSession | null> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }

  const tabUrl = tab.url ?? '';
  if (!isOrgUrl(tabUrl)) {
    return null;
  }

  let originalHostname: string;
  try {
    originalHostname = new URL(tabUrl).hostname;
  } catch {
    return null;
  }

  const apiDomain = deriveApiDomain(originalHostname);

  // Try the derived API domain first, then fall back to original hostname
  const domainsToTry = [apiDomain];
  if (originalHostname !== apiDomain) {
    domainsToTry.push(originalHostname);
  }

  for (const domain of domainsToTry) {
    const cookieUrl = `https://${domain}`;
    let cookie: chrome.cookies.Cookie | null = null;
    try {
      cookie = await chrome.cookies.get({ url: cookieUrl, name: 'sid' });
    } catch {
      // permissions may not cover this domain
    }
    if (cookie) {
      return {
        orgUrl: `https://${domain}`,
        orgDomain: domain,
        sid: cookie.value,
        apiVersion: 'v62.0',
      };
    }
  }

  return null;
}
