import React from 'react';
import DataPackTab from './DataPackTab';
import DebuggerTab from './DebuggerTab';

declare const __OMNITOOLS_STORE_BUILD__: boolean;

export interface TabDef {
  id: string;
  label: string;
  icon: string;
  component: React.ComponentType;
  pill?: string;
  devOnly?: boolean;
}

const DEV_TABS: TabDef[] = __OMNITOOLS_STORE_BUILD__ ? [] : [{
  id: 'headless',
  label: 'Headless',
  icon: '◈',
  component: React.lazy(() => import('./HeadlessTab')),
  pill: 'exp',
  devOnly: true,
}];

export const TABS: TabDef[] = [
  { id: 'datapack',  label: 'DataPack',  icon: '⇄', component: DataPackTab },
  { id: 'debugger',  label: 'Debugger',  icon: '⬡', component: DebuggerTab },
  ...DEV_TABS,
];

export const DEV_UNLOCK_KEY = 'omnitools_unlock';
export const DEV_UNLOCK_VALUE = 'headless-dev-2026';

export function visibleTabs(): TabDef[] {
  if (__OMNITOOLS_STORE_BUILD__) return TABS.filter(tab => !tab.devOnly);
  const unlocked = localStorage.getItem(DEV_UNLOCK_KEY) === DEV_UNLOCK_VALUE;
  return TABS.filter(tab => !tab.devOnly || unlocked);
}
