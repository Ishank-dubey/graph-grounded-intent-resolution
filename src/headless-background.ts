import { getSessionForTab } from './auth.js';
import { SalesforceAPI } from './sf-api.js';
import { buildHeadlessGraph } from './datapack/exporter.js';

type HeadlessMessage =
  | { type: 'BUILD_HEADLESS_GRAPH'; tabId: number }
  | {
      type: 'EINSTEIN_QUERY';
      tabId: number;
      prompt: string;
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    }
  | {
      type: 'EXECUTE_IP';
      tabId: number;
      ipKey: string;
      input: Record<string, unknown>;
    }
  | {
      /** Execute a DataRaptor directly via the DataMapper REST API */
      type: 'EXECUTE_DR';
      tabId: number;
      drBundle: string;
      drType: string;
      input: Record<string, unknown>;
    }
  | {
      /** Validate an API key without saving it — uses max_tokens:1 to minimise cost */
      type: 'TEST_AI_KEY';
      provider: 'anthropic' | 'openai';
      key: string;
      model: string;
    };

type MessageResponse =
  | { success: true; data: unknown }
  | { success: false; error: string };

async function createApi(tabId: number): Promise<SalesforceAPI | null> {
  const session = await getSessionForTab(tabId);
  if (!session) return null;
  const api = new SalesforceAPI(session.orgDomain, session.sid, session.apiVersion);
  await api.detectLatestApiVersion();
  return api;
}

async function handleHeadlessMessage(msg: HeadlessMessage): Promise<MessageResponse> {
  if (msg.type === 'TEST_AI_KEY') {
    try {
      if (msg.provider === 'anthropic') {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': msg.key,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: msg.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          // Extract the human-readable error message from Anthropic's JSON error body
          try {
            const err = JSON.parse(body) as { error?: { message?: string } };
            return { success: false, error: err.error?.message ?? `HTTP ${resp.status}` };
          } catch { return { success: false, error: `HTTP ${resp.status}: ${body.slice(0, 120)}` }; }
        }
        return { success: true, data: { model: msg.model } };
      }

      if (msg.provider === 'openai') {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${msg.key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: msg.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          try {
            const err = JSON.parse(body) as { error?: { message?: string } };
            return { success: false, error: err.error?.message ?? `HTTP ${resp.status}` };
          } catch { return { success: false, error: `HTTP ${resp.status}: ${body.slice(0, 120)}` }; }
        }
        return { success: true, data: { model: msg.model } };
      }

      return { success: false, error: 'Unknown provider' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (msg.type === 'EXECUTE_IP') {
    const api = await createApi(msg.tabId);
    if (!api) return { success: false, error: 'No Salesforce session found for this tab' };
    try {
      const result = await api.executeIntegrationProcedure(msg.ipKey, msg.input);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (msg.type === 'EXECUTE_DR') {
    const api = await createApi(msg.tabId);
    if (!api) return { success: false, error: 'No Salesforce session found for this tab' };
    try {
      const result = await api.executeDataMapper(msg.drBundle, msg.input, msg.drType);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (msg.type === 'BUILD_HEADLESS_GRAPH') {
    const session = await getSessionForTab(msg.tabId);
    if (!session) return { success: false, error: 'No Salesforce session found for this tab' };
    const api = new SalesforceAPI(session.orgDomain, session.sid, session.apiVersion);
    await api.detectLatestApiVersion();
    return { success: true, data: await buildHeadlessGraph(api, session.orgUrl) };
  }

  type AiConfig = {
    provider?: 'einstein' | 'anthropic' | 'openai';
    anthropicKey?: string;
    anthropicModel?: string;
    openaiKey?: string;
    openaiModel?: string;
  };
  const stored = await chrome.storage.local.get('aiConfig');
  const config: AiConfig = (stored['aiConfig'] as AiConfig) ?? {};
  const provider = config.provider ?? 'einstein';
  const messages = msg.messages?.length
    ? msg.messages
    : [{ role: 'user' as const, content: msg.prompt }];

  if (provider === 'anthropic') {
    if (!config.anthropicKey) return { success: false, error: 'Anthropic API key not set' };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.anthropicModel ?? 'claude-opus-4-5',
        max_tokens: 2048,
        messages,
      }),
    });
    if (!response.ok) return { success: false, error: `Anthropic API error ${response.status}: ${(await response.text()).slice(0, 200)}` };
    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    return { success: true, data: { text: data.content?.find((block) => block.type === 'text')?.text ?? '' } };
  }

  if (provider === 'openai') {
    if (!config.openaiKey) return { success: false, error: 'OpenAI API key not set' };
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.openaiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openaiModel ?? 'gpt-4o',
        max_tokens: 2048,
        messages,
      }),
    });
    if (!response.ok) return { success: false, error: `OpenAI API error ${response.status}: ${(await response.text()).slice(0, 200)}` };
    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return { success: true, data: { text: data.choices?.[0]?.message?.content ?? '' } };
  }

  const api = await createApi(msg.tabId);
  if (!api) return { success: false, error: 'No Salesforce session found for this tab' };
  const prompt = messages.length > 1
    ? messages.map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${message.content}`).join('\n\n---\n\n')
    : msg.prompt;
  return { success: true, data: { text: await api.einsteinGenerate(prompt) } };
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  const type = (msg as { type?: string }).type;
  if (type !== 'BUILD_HEADLESS_GRAPH' && type !== 'EINSTEIN_QUERY' && type !== 'EXECUTE_IP' && type !== 'EXECUTE_DR' && type !== 'TEST_AI_KEY') return false;

  handleHeadlessMessage(msg as HeadlessMessage)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
});
