import React, { useEffect, useRef, useState } from 'react';

export type AiProvider = 'einstein' | 'anthropic' | 'openai';

export interface AiConfig {
  provider: AiProvider;
  anthropicKey: string;
  anthropicModel: string;
  openaiKey: string;
  openaiModel: string;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'einstein',
  anthropicKey: '',
  anthropicModel: 'claude-opus-4-5',
  openaiKey: '',
  openaiModel: 'gpt-4o',
};

const STORAGE_KEY = 'aiConfig';

export async function loadAiConfig(): Promise<AiConfig> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_AI_CONFIG, ...(result[STORAGE_KEY] as Partial<AiConfig> ?? {}) };
}

export async function saveAiConfig(cfg: AiConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
}

// Short label for the Ask button based on active config
export function aiButtonLabel(cfg: AiConfig | null): string {
  if (!cfg || cfg.provider === 'einstein') return '✦ Ask Einstein';
  if (cfg.provider === 'anthropic') return '✦ Ask Claude';
  return '✦ Ask GPT-4o';
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  onSaved: (cfg: AiConfig) => void;
}

export function AiSettings({ onClose, onSaved }: Props) {
  const [cfg, setCfg] = useState<AiConfig>(DEFAULT_AI_CONFIG);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadAiConfig().then(setCfg);
  }, []);

  // Clear test result when provider or key changes
  useEffect(() => { setTestResult(null); }, [cfg.provider, cfg.anthropicKey, cfg.openaiKey, cfg.anthropicModel, cfg.openaiModel]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = async () => {
    // For Anthropic / OpenAI: validate key first, then save
    const needsTest = (cfg.provider === 'anthropic' && cfg.anthropicKey.trim()) ||
                      (cfg.provider === 'openai'    && cfg.openaiKey.trim());

    if (needsTest && !testResult?.ok) {
      setTesting(true);
      setTestResult(null);

      type Resp = { success: true; data: unknown } | { success: false; error: string };
      const resp = await chrome.runtime.sendMessage<unknown, Resp>({
        type: 'TEST_AI_KEY',
        provider: cfg.provider,
        key:   cfg.provider === 'anthropic' ? cfg.anthropicKey.trim() : cfg.openaiKey.trim(),
        model: cfg.provider === 'anthropic' ? cfg.anthropicModel      : cfg.openaiModel,
      });
      setTesting(false);

      if (!resp.success) {
        setTestResult({ ok: false, msg: resp.error });
        return; // don't save — let user fix the key
      }
      setTestResult({ ok: true, msg: `Connected — ${cfg.provider === 'anthropic' ? cfg.anthropicModel : cfg.openaiModel}` });
    }

    setSaving(true);
    await saveAiConfig(cfg);
    setSaving(false);
    setSaved(true);
    setTimeout(() => { setSaved(false); onSaved(cfg); }, 1200);
  };

  const update = (partial: Partial<AiConfig>) =>
    setCfg((prev) => ({ ...prev, ...partial }));

  return (
    <div className="ai-settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ai-settings-panel" ref={panelRef}>
        <div className="ai-settings__header">
          <span className="ai-settings__title">AI Provider Settings</span>
          <button className="ai-settings__close" onClick={onClose} title="Close">&#x2715;</button>
        </div>

        <div className="ai-settings__body">
          {/* Provider selector */}
          <div className="ai-settings__field">
            <label className="ai-settings__label">Provider</label>
            <div className="ai-settings__radio-group">
              {([
                ['einstein', '✦ Salesforce Einstein', 'Uses your org\'s Einstein Gen AI — no key required, but must be enabled in the org.'],
                ['anthropic', '⬡ Anthropic (Claude)', 'Uses your Anthropic API key. Stored locally in this browser only.'],
                ['openai',    '◎ OpenAI',             'Uses your OpenAI API key. Stored locally in this browser only.'],
              ] as [AiProvider, string, string][]).map(([val, label, desc]) => (
                <label
                  key={val}
                  className={`ai-settings__radio${cfg.provider === val ? ' ai-settings__radio--selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="provider"
                    value={val}
                    checked={cfg.provider === val}
                    onChange={() => update({ provider: val })}
                  />
                  <div>
                    <span className="ai-settings__radio-label">{label}</span>
                    <span className="ai-settings__radio-desc">{desc}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Anthropic section */}
          {cfg.provider === 'anthropic' && (
            <>
              <div className="ai-settings__field">
                <label className="ai-settings__label">Anthropic API Key</label>
                <input
                  className="ai-settings__input"
                  type="password"
                  placeholder="sk-ant-…"
                  value={cfg.anthropicKey}
                  onChange={(e) => update({ anthropicKey: e.target.value })}
                  autoComplete="off"
                />
                <span className="ai-settings__hint">
                  Get a key at <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">console.anthropic.com</a>.
                  Stored in <code>chrome.storage.local</code> — never synced or sent to anyone except Anthropic.
                </span>
              </div>
              <div className="ai-settings__field">
                <label className="ai-settings__label">Model</label>
                <select
                  className="ai-settings__select"
                  value={cfg.anthropicModel}
                  onChange={(e) => update({ anthropicModel: e.target.value })}
                >
                  <option value="claude-opus-4-5">claude-opus-4-5 (most capable)</option>
                  <option value="claude-sonnet-4-5">claude-sonnet-4-5 (balanced)</option>
                  <option value="claude-haiku-4-5">claude-haiku-4-5 (fastest)</option>
                  <option value="claude-3-5-sonnet-20241022">claude-3-5-sonnet-20241022</option>
                  <option value="claude-3-opus-20240229">claude-3-opus-20240229</option>
                </select>
              </div>
            </>
          )}

          {/* OpenAI section */}
          {cfg.provider === 'openai' && (
            <>
              <div className="ai-settings__field">
                <label className="ai-settings__label">OpenAI API Key</label>
                <input
                  className="ai-settings__input"
                  type="password"
                  placeholder="sk-…"
                  value={cfg.openaiKey}
                  onChange={(e) => update({ openaiKey: e.target.value })}
                  autoComplete="off"
                />
                <span className="ai-settings__hint">
                  Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com</a>.
                  Stored in <code>chrome.storage.local</code> — never synced or sent to anyone except OpenAI.
                </span>
              </div>
              <div className="ai-settings__field">
                <label className="ai-settings__label">Model</label>
                <select
                  className="ai-settings__select"
                  value={cfg.openaiModel}
                  onChange={(e) => update({ openaiModel: e.target.value })}
                >
                  <option value="gpt-4o">gpt-4o (recommended)</option>
                  <option value="gpt-4o-mini">gpt-4o-mini (fast / cheap)</option>
                  <option value="gpt-4-turbo">gpt-4-turbo</option>
                  <option value="o1-preview">o1-preview (reasoning)</option>
                </select>
              </div>
            </>
          )}
        </div>

        {/* Test result banner */}
        {testResult && (
          <div className={`ai-settings__test-result ${testResult.ok ? 'ai-settings__test-result--ok' : 'ai-settings__test-result--err'}`}>
            {testResult.ok ? '✓' : '✕'} {testResult.msg}
          </div>
        )}

        <div className="ai-settings__footer">
          <button className="btn btn--secondary btn--sm" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary btn--sm"
            onClick={() => void handleSave()}
            disabled={saving || testing}
          >
            {saved   ? '✓ Saved'
             : saving  ? 'Saving…'
             : testing ? '⏳ Testing…'
             : testResult?.ok ? 'Save'
             : (cfg.provider === 'anthropic' && cfg.anthropicKey.trim()) ||
               (cfg.provider === 'openai'    && cfg.openaiKey.trim())
               ? 'Test & Save'
               : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
