/**
  * Prompt Panel — read, translate, search and export SillyTavern presets,
  * world info and character cards.
 */

// ── Build identity ─────────────────────────────────────────────────────
// The release build and the private test build differ ONLY in this block
// (plus manifest.json). The test build keeps its own settings key and
// IndexedDB, so testing never touches the release build's data.
// @build-identity:start
const BUILD = {
    ext:        'prompt-panel',
    title:      'Prompt Panel',
    db:         'PTTranslationDB_PLUS',    // historical name, kept for existing users
    metaDb:     'PromptPanelMeta',
    fabKey:     '__stPresetTranslator_fabWatcher',
};
// @build-identity:end

const EXT = BUILD.ext;
// CSS URL is derived from this script's own URL (import.meta.url) so it works
// regardless of the actual folder name on disk (e.g. when installed via GitHub
// the folder may be named after the repo, not after EXT).
const SELF_DIR_URL = (() => {
    try { return new URL('./', import.meta.url).href; } catch(e) { return ''; }
})();
const CSS_URL = SELF_DIR_URL ? (SELF_DIR_URL + 'style.css') : '';

// Status Tray / QR Floating 방식: parent.document
const PAR  = (function(){ try { return window.parent || window; } catch(e){ return window; } })();
const PDOC = (function(p){ try { return p.document || document; } catch(e){ return document; } })(PAR);

// ── Dynamic imports ────────────────────────────────────────────────────
let getRequestHeaders, saveSettingsDebounced, eventSource, event_types,
    extension_settings, getContext,
    oai_settings, openai_settings, openai_setting_names, stOpenai, stSecrets,
    characters, unshallowCharacter, world_names, world_info;

async function initImports() {
    const s = import.meta.url;
    const tp = s.includes('/third-party/');
    const base  = tp ? '../../../../' : '../../../';
    const base2 = tp ? '../../../'    : '../../';

    const sm = await import(base + 'script.js');
    getRequestHeaders     = sm.getRequestHeaders;
    saveSettingsDebounced = sm.saveSettingsDebounced;
    eventSource           = sm.eventSource;
    event_types           = sm.event_types;
    characters            = sm.characters;
    unshallowCharacter    = sm.unshallowCharacter;

    const om = stOpenai = await import(base2 + 'openai.js');
    oai_settings         = om.oai_settings;
    openai_settings      = om.openai_settings;
    openai_setting_names = om.openai_setting_names;
    addConnectionKeysFromSt(om.settingsToUpdate);

    const em = await import(base2 + 'extensions.js');
    extension_settings = em.extension_settings;
    getContext         = em.getContext;

    try { stSecrets = await import(base2 + 'secrets.js'); } catch (e) {}   // only read, for savedKeyFor()

    const wi = await import(base2 + 'world-info.js');
    world_names      = wi.world_names;
    world_info       = wi.world_info;
}

// ── Connection ────────────────────────────────────────────────────────
// One row per service the panel can talk to (always through SillyTavern's
// server, which holds the keys):
//   label   name shown in the settings
//   source  SillyTavern's id for it, when that differs from our key
//   turn    what the model's own turn is called (prefill, Ask history); 'assistant' unless given
//   knobs   sampling values the service takes, in the order shown and sent
//   models  suggestions for the model list; any other name can be typed in
//   noPrefill  the translation prefill is never sent to this service
// The row order is the order of the service list in the settings.
const KNOBS = {
    temperature:       { label: 'Temperature',   min: 0,  max: 2,   step: 0.05, def: 1 },
    top_p:             { label: 'Top P',         min: 0,  max: 1,   step: 0.01, def: 1 },
    top_k:             { label: 'Top K',         min: 0,  max: 200, step: 1,    def: 0 },
    frequency_penalty: { label: 'Freq. Penalty', min: -2, max: 2,   step: 0.05, def: 0 },
    presence_penalty:  { label: 'Pres. Penalty', min: -2, max: 2,   step: 0.05, def: 0 },
};
const K_PLAIN = ['temperature', 'top_p'];
const K_TOPK  = [...K_PLAIN, 'top_k'];
const K_PEN   = [...K_PLAIN, 'frequency_penalty', 'presence_penalty'];
// Model lists: what each vendor's own documentation lists as served on
// 2026-11-16, newest first; deprecated and retired models are left out. They
// are suggestions only: a saved model that is not listed keeps working and is
// still shown in the box, and any name can be typed in.
const GEMINI_MODELS = ['gemini-4-hydrogen','gemini-4-carbon','gemini-4-argon','gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-3.1-pro-preview','gemini-3-flash-preview','gemini-2.5-flash-lite'];
const SERVICES = {
    openai:     { label: 'OpenAI', knobs: K_PEN,
                  models: ['gpt-6.1-terra','gpt-6.1-sol','gpt-6-luna','gpt-6-sol','gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5','gpt-5.4-mini','gpt-5.4','gpt-5.2'] },
    claude:     { label: 'Claude', knobs: K_TOPK,
                  models: ['claude-fable-5-2','claude-haiku-5-5','claude-sonnet-5-5','claude-opus-5-5','claude-fable-5-1','claude-opus-5','claude-sonnet-5','claude-fable-5','claude-opus-4-8','claude-opus-4-7','claude-sonnet-4-6','claude-opus-4-6','claude-opus-4-5','claude-haiku-4-5'] },
    google:     { label: 'Google AI Studio', source: 'makersuite', turn: 'model', knobs: K_TOPK, models: GEMINI_MODELS },
    vertexai:   { label: 'Google Vertex AI', turn: 'model', knobs: K_TOPK, models: GEMINI_MODELS },
    openrouter: { label: 'OpenRouter', knobs: K_PEN,
                  models: ['qwen/qwen4-max','google/gemini-4-hydrogen','google/gemini-4-carbon','anthropic/claude-fable-5.2','openai/gpt-6.1-terra','moonshotai/kimi-k3.1-pro','google/gemini-4-argon','anthropic/claude-haiku-5.5','mistralai/mistral-large-4-0','openai/gpt-6.1-sol','anthropic/claude-sonnet-5.5','openai/gpt-6-luna','anthropic/claude-opus-5.5','x-ai/grok-4.7','deepseek/deepseek-v4.1-flash','openai/gpt-6-astra','google/gemini-3.8-flash','z-ai/glm-5.3','deepseek/deepseek-v4-pro'] },
    deepseek:   { label: 'DeepSeek', knobs: K_PEN, models: ['deepseek-flash','deepseek-v4-pro'] },
    zai:        { label: 'Z.AI (GLM)', knobs: K_PLAIN,
                  models: ['glm-5.3-flashx','glm-5.3-flash','glm-5.3','glm-5.2','glm-5.1','glm-5','glm-4.7-flashx','glm-4.7-flash','glm-4.7','glm-4.6','glm-4.5','glm-4.5-air','glm-4.5-flash'] },
    // Any OpenAI-compatible address (SillyTavern's "Custom" source): see callModel()
    custom:     { label: 'Custom (OpenAI 호환)', knobs: K_PLAIN, models: [], noPrefill: true },
};
// Newer models refuse things older ones took, by the vendors' own migration
// notes. Matched anywhere in the id, so ids with a vendor prefix (OpenRouter,
// relays) and with dots instead of dashes are covered too.
//   NO_SAMPLING  temperature / top_p / top_k are gone: Gemini 3.5 and later,
//                Claude Opus 4.7 and later, every Claude 5 / Fable model
//   NO_PREFILL   a request may not end with the model's own turn: Gemini 3.5
//                and later, Claude 4.6 and later
const NO_SAMPLING = /gemini-(3\.[5-9]|[4-9])|claude-(fable|mythos|(opus|sonnet|haiku)-[5-9]|opus-4[-.][7-9])/;
const NO_PREFILL  = /gemini-(3\.[5-9]|[4-9])|claude-(fable|mythos|(opus|sonnet|haiku)-[5-9]|(opus|sonnet)-4[-.][6-9])/;
const MODEL_TYPED = '__custom__';   // saved model value meaning "use the typed-in name"
const PREFILL_DEFAULT = 'Understood. I will translate the text following every rule above. Translation:';

// Rules SillyTavern's own chat screen applies before it sends a request
// (openai.js). The panel sends straight to ST's server, which forwards the
// values as they are, so the same rules are applied here, last.
//  - Claude requires max_tokens. ST always sends its response length; the
//    panel sends a fixed default unless Ask's own length is set. Models that
//    think unless told otherwise get a higher one: their thinking counts
//    toward the limit, and a reply cut by it cannot be told from a whole one.
//  - OpenAI reasoning models (o1/o3/o4, gpt-5, gpt-6): ST removes the sampling
//    values these models reject and renames max_tokens. Same here. ST 1.19
//    knows gpt-6-astra only; the rest of the GPT-6 family follows OpenAI's
//    guide (no temperature / top_p unless reasoning is off).
//  - Models that dropped sampling values altogether (NO_SAMPLING above).
//  - Claude thinking: ST sends its reasoning effort ('auto' by default, which
//    leaves thinking off). Without one, ST's server turns thinking on with a
//    1024-token budget, so 'auto' is sent to behave like ST's default.
const CLAUDE_DEFAULT_MAX_TOKENS = 8192, CLAUDE_THINKING_MAX_TOKENS = 16000;
const CLAUDE_THINKS = /claude-(fable|mythos|(opus|sonnet|haiku)-[5-9])/;   // Claude 5 family and Fable: thinking is on by default
function finalizeRequest(p) {
    const src = p.chat_completion_source, model = String(p.model || '');
    if (src === 'claude' && !(p.max_tokens > 0)) {
        // The first Claude 3 models cannot write more than 4096 tokens
        p.max_tokens = /^claude-3-(opus|sonnet|haiku)/.test(model) ? 4096 : CLAUDE_THINKS.test(model) ? CLAUDE_THINKING_MAX_TOKENS : CLAUDE_DEFAULT_MAX_TOKENS;
    }
    if (src === 'claude' && p.reasoning_effort === undefined) p.reasoning_effort = 'auto';
    // OpenAI's models are also reached through OpenRouter and through relays set up as Custom
    const direct = src === 'openai' || src === 'custom', routed = direct || src === 'openrouter';
    const isO = (direct && /^(o1|o3|o4)/.test(model)) || (src === 'openrouter' && /^openai\/(o1|o3|o4)/.test(model));
    const isGpt5 = routed && /gpt-5/.test(model), isGpt6 = routed && /gpt-6/.test(model);
    if ((isO || isGpt5 || isGpt6) && p.max_tokens !== undefined) {
        p.max_completion_tokens = p.max_tokens;
        delete p.max_tokens;
    }
    if (isO) {
        delete p.temperature; delete p.top_p;
        delete p.frequency_penalty; delete p.presence_penalty;
    }
    if (isGpt5 && !/gpt-5-chat-latest/.test(model)) {
        delete p.frequency_penalty; delete p.presence_penalty;
        // gpt-5.1–5.4 keep temperature / top_p when no reasoning effort is sent
        // (the panel never sends one) — except their chat-latest variants, as in ST
        if (!(/gpt-5\.(1|2|3|4)/.test(model) && !/chat-latest/.test(model))) { delete p.temperature; delete p.top_p; }
    }
    if (isGpt6) { delete p.temperature; delete p.top_p; }
    if (NO_SAMPLING.test(model)) {
        delete p.temperature; delete p.top_p; delete p.top_k;
        delete p.frequency_penalty; delete p.presence_penalty;
    }
    return p;
}

// Reads a reply as SillyTavern's server returns it. Returns { text, cut }.
//  - Native Claude: ST copies only the FIRST content block into `choices`;
//    with thinking that block is the thinking, so the text blocks are joined
//    the way ST's own screen does (script.js). Thinking is never included.
//  - Errors ST sends with HTTP 200 (Gemini "no candidate" / blocked prompt,
//    some proxies) are thrown instead of reading as an empty answer.
//  - cut: the reply stopped at the output limit. Only OpenAI-compatible
//    replies say so; ST does not pass Claude's or Gemini's stop reason on.
// For a refused request SillyTavern often passes on nothing but the HTTP
// status text. What that usually means, for a screen with no server log:
const STATUS_HINT = {
    'Unauthorized': 'API 키가 없거나 틀립니다',
    'Forbidden': '이 키로는 쓸 수 없거나 접근이 막혀 있습니다',
    'Not Found': '주소나 모델명이 틀립니다',
    'Bad Request': '서버가 요청을 거절했습니다 (모델명·설정값 확인)',
    'Payment Required': '잔액이 부족합니다',
    'Too Many Requests': '요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요',
};
function readReply(d) {
    if (!d || typeof d !== 'object') throw new Error('응답을 읽을 수 없습니다');
    if (d.error) {
        const m = typeof d.error === 'object' ? d.error.message : d.error;
        if (typeof m !== 'string' || !m) throw new Error('API 오류 (자세한 내용은 실리태번 서버 기록에 있습니다)');
        throw new Error(STATUS_HINT.hasOwnProperty(m) ? `${m} — ${STATUS_HINT[m]}` : m);
    }
    let text = '';
    if (Array.isArray(d.content)) text = d.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n');
    const msg = d.choices?.[0]?.message;
    if (!text && typeof msg?.content === 'string') text = msg.content;
    if (!text && Array.isArray(d.candidates?.[0]?.content?.parts)) text = d.candidates[0].content.parts.filter(p => p && !p.thought).map(p => p.text || '').join('');
    text = String(text || '').trim();
    if (!text && typeof msg?.refusal === 'string' && msg.refusal) throw new Error(`모델이 답변을 거절했습니다: ${msg.refusal}`);
    const finish = String(d.choices?.[0]?.finish_reason || d.candidates?.[0]?.finishReason || d.stop_reason || '');
    return { text, cut: /^(length|max_tokens)$/i.test(finish) };
}

// The row of the chosen service. A key the table does not know (settings
// edited by hand) is still sent, with the two values every service takes.
const serviceRow = key => SERVICES[key] || { knobs: K_PLAIN, models: [] };
// The model to ask for: the typed-in name when that option is chosen.
function modelName() {
    const c = cfg();
    return String((c.model === MODEL_TYPED ? c.customModelName : c.model) || '').trim();
}
// Role name of the model's own turn for the chosen service.
const modelTurn = () => serviceRow(cfg().provider).turn || 'assistant';
// Saved sampling values of the chosen service. Kept per service, so going
// back to a service brings its values back; created with defaults on first use.
function savedKnobs() {
    const c = cfg(), key = c.provider;
    if (!c.parameters[key]) c.parameters[key] = Object.fromEntries(serviceRow(key).knobs.map(k => [k, KNOBS[k].def]));
    return c.parameters[key];
}
// One saved value; the default when it is missing or not a number.
const knob = (saved, k) => (typeof saved[k] === 'number' && isFinite(saved[k])) ? saved[k] : KNOBS[k].def;

// Every request of the panel goes out here: translation, title / name lists
// and Ask. Builds the body from the saved connection settings, posts it to
// SillyTavern's server and returns readReply()'s { text, cut }.
//   opt.prefill      end with the translation prefill as the model's first words
//   opt.vary         re-translation: nudge sampling so the same answer is less likely
//   opt.maxTokens, opt.temperature   Ask's own values (0 / not a number = not used)
//   opt.signal       lets a stop button cancel the request
async function callModel(messages, opt = {}) {
    const c = cfg(), row = serviceRow(c.provider), saved = savedKnobs();
    const body = { model: modelName(), messages, stream: false, chat_completion_source: row.source || c.provider };
    for (const k of row.knobs) body[k] = knob(saved, k);

    // No prefill where it would be refused (or, for an unknown Custom address, is not part of the format)
    const lead = opt.prefill && c.prefillEnabled && !row.noPrefill && !NO_PREFILL.test(body.model) ? String(c.prefillText || '').trim() : '';
    if (lead) body.messages = [...messages, { role: modelTurn(), content: lead }];
    if (opt.vary) {
        body.top_p = Math.min(1, body.top_p * 0.97);
        if ('top_k' in body) body.top_k = Math.max(1, body.top_k || 40);
    }
    if (opt.maxTokens > 0) body.max_tokens = opt.maxTokens;
    if (typeof opt.temperature === 'number') body.temperature = opt.temperature;

    if (body.chat_completion_source === 'vertexai') {
        // Vertex sign-in details are SillyTavern's own connection settings. Its
        // server needs to be told which mode is in use, and the region / project.
        const mode = oai_settings?.vertexai_auth_mode || 'full';
        body.vertexai_auth_mode = mode;
        if (oai_settings?.vertexai_region) body.vertexai_region = oai_settings.vertexai_region;
        if (mode === 'express' && oai_settings?.vertexai_express_project_id) body.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
    }
    if (c.provider === 'custom') {
        // SillyTavern's "Custom (OpenAI-compatible)" source: its server posts to
        // <address>/chat/completions. The key: see customAuth().
        await customKeyReady;
        customAuth(body);
        if (!body.custom_url) throw new Error('Custom 엔드포인트 주소가 비어 있습니다 (확장 설정 → API 설정)');
    } else {
        const proxy = c.useReverseProxy ? String(c.reverseProxyUrl || '').trim() : '';
        if (proxy) { body.reverse_proxy = proxy; body.proxy_password = c.reverseProxyPassword || ''; }
    }

    const res = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(finalizeRequest(body)), signal: opt.signal,
    });
    if (!res.ok) {
        // Status code, then the reason: the message of a JSON error, or short
        // plain text. An HTML error page is left out (unreadable in the panel).
        let why = '';
        try { why = (await res.text()).trim(); } catch (e) {}
        try { const j = JSON.parse(why), m = j?.error?.message || j?.message; why = typeof m === 'string' ? m : ''; } catch (e) { if (why[0] === '<') why = ''; }
        why = why.replace(/\s+/g, ' ').trim().slice(0, 200);
        throw new Error(`API ${res.status}${why ? ' — ' + why : ''}`);
    }
    return readReply(await res.json());
}

// ── Settings ──────────────────────────────────────────────────────────
function cfg() {
    if (!extension_settings[EXT]) extension_settings[EXT] = {};
    const c = extension_settings[EXT];
    if (!c.targetLang)    c.targetLang    = 'Korean';
    if (!c.provider)      c.provider      = 'openai';
    if (!c.model)         c.model         = 'gpt-6-luna';
    if (c.prefillEnabled === undefined) c.prefillEnabled = true;
    if (!c.prefillText)   c.prefillText   = PREFILL_DEFAULT;   // an emptied box goes back to the default
    if (c.useReverseProxy === undefined) c.useReverseProxy = false;
    if (!c.reverseProxyUrl) c.reverseProxyUrl = '';
    if (!c.reverseProxyPassword) c.reverseProxyPassword = '';
    if (typeof c.customUrl !== 'string') c.customUrl = '';   // Custom endpoint address (its key is not kept here, see customKey)
    if (!c.theme)         c.theme         = 'dark';
    if (c.fabVisible === undefined) c.fabVisible = true;
    if (typeof c.originalFontSize !== 'number')   c.originalFontSize   = 11;
    if (typeof c.translatedFontSize !== 'number') c.translatedFontSize = 12;
    // Throttling / batching
    if (typeof c.titleBatchSize !== 'number' || c.titleBatchSize < 1) c.titleBatchSize = 15;
    if (typeof c.requestDelayMs !== 'number' || c.requestDelayMs < 0) c.requestDelayMs = 60;
    // Ask
    if (typeof c.askBudget !== 'number' || c.askBudget < 1000) c.askBudget = 60000;   // material ceiling (tokens)
    if (typeof c.askMaxTokens !== 'number' || c.askMaxTokens < 0) c.askMaxTokens = 0;   // 0 = model default
    if (c.askTemperature !== null && typeof c.askTemperature !== 'number') c.askTemperature = null; // null = use translation setting
    if (!['full', 'names', 'off'].includes(c.askRegexMode)) c.askRegexMode = 'names';
    if (typeof c.askIncludeScripts !== 'boolean') c.askIncludeScripts = true;
    if (typeof c.askIncludeBook !== 'boolean') c.askIncludeBook = true;
    if (typeof c.askBookEnabledOnly !== 'boolean') c.askBookEnabledOnly = true;
    if (!c.parameters || typeof c.parameters !== 'object') c.parameters = {};   // sampling values per service, see savedKnobs()
    return c;
}

// ── Translation Cache Layer (IndexedDB + in-memory Map) ──────────────
// Design: IndexedDB for persistence, Map for sync reads matching old API
const DB_NAME = BUILD.db;
const DB_VERSION = 1;
const STORE = 'translations';
let _db = null;
let _dbFailed = false;
const translationMap = new Map();  // in-memory mirror, key → translation string

function openTranslationDB() {
    return new Promise((resolve, reject) => {
        if (_db) return resolve(_db);
        if (_dbFailed) return reject(new Error('IndexedDB unavailable'));
        try {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (ev) => {
                const db = ev.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'cacheKey' });
                    store.createIndex('savedAt', 'savedAt', { unique: false });
                }
            };
            req.onsuccess = (ev) => { _db = ev.target.result; resolve(_db); };
            req.onerror  = (ev) => {
                _dbFailed = true;
                console.warn(`[${EXT}] IndexedDB open failed, falling back to in-memory only`, ev);
                reject(new Error('IndexedDB open failed'));
            };
        } catch (e) {
            _dbFailed = true;
            console.warn(`[${EXT}] IndexedDB unavailable, in-memory fallback`, e);
            reject(e);
        }
    });
}

// Bulk write in ONE transaction. Importing thousands of entries one
// transaction at a time is slow on mobile. Unlike dbPut, errors propagate
// so the importer can report a failed save honestly.
async function dbPutMany(pairs) {
    const db = await openTranslationDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const st = tx.objectStore(STORE);
        const now = Date.now();
        for (const [cacheKey, translation] of pairs) st.put({ cacheKey, translation, savedAt: now });
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error);
    });
}

async function dbGetAll() {
    try {
        const db = await openTranslationDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror   = () => reject(req.error);
        });
    } catch(e) { return []; }
}

// A translation that could not be written stays on screen for this session
// only. Say so (at most once a minute, so a run of failures is one notice).
let _saveWarnAt = 0;
function warnNotSaved(e) {
    console.warn(`[${EXT}] translation not saved to IndexedDB`, e);
    const now = Date.now();
    if (now - _saveWarnAt < 60000) return;
    _saveWarnAt = now;
    if (typeof toastr !== 'undefined') toastr.warning('번역을 브라우저 저장소에 저장하지 못했어요. 지금 화면에는 보이지만 새로고침하면 사라질 수 있어요. 기기 저장 공간을 확인하고, 확장 설정의 번역 캐시 백업을 받아 두세요.', '', { timeOut: 12000 });
}

// Counts as saved only when the transaction completes
async function dbPut(cacheKey, translation) {
    try {
        const db = await openTranslationDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({ cacheKey, translation, savedAt: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
            tx.onabort    = () => reject(tx.error || new Error('aborted'));
        });
    } catch(e) { warnNotSaved(e); }   // the in-memory copy still serves this session
}

async function dbDelete(cacheKey) {
    try {
        const db = await openTranslationDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const req = tx.objectStore(STORE).delete(cacheKey);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    } catch(e) {}
}

async function dbClear() {
    try {
        const db = await openTranslationDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const req = tx.objectStore(STORE).clear();
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    } catch(e) {}
}

// Load all translations into memory Map at startup
async function initTranslationCache() {
    // Load existing IndexedDB records into the in-memory Map.
    const all = await dbGetAll();
    for (const rec of all) {
        if (rec.cacheKey && rec.translation) {
            translationMap.set(rec.cacheKey, rec.translation);
        }
    }
    console.log(`[${EXT}] Translation cache loaded: ${translationMap.size} entries`);
}

// Effective target language string.
// The dropdown may hold the sentinel '__custom__', in which case the user's
// free-text language (customLang) is what we actually send to the model and
// what we key the cache by. Never let '__custom__' itself reach a cache key.
function effLang() {
    const c = cfg();
    if (c.targetLang === '__custom__') {
        const custom = (c.customLang || '').trim();
        return custom || 'Korean';
    }
    return c.targetLang || 'Korean';
}

const ck        = (ns, id) => `${ns}::${id}::${effLang()}`;
const getCached = (ns, id) => translationMap.get(ck(ns, id)) ?? null;
const setCache  = (ns, id, t) => {
    const key = ck(ns, id);
    translationMap.set(key, t);
    dbPut(key, t);  // fire-and-forget async persist
};

// Title-only translations live in a sibling namespace so that they never
// shadow a full translation. Consequences of this separation:
//   - Pressing 번역 later still performs a full translation (no cache hit).
//   - 👀 and script export prefer the full translation's title when present,
//     and fall back to the title-only cache otherwise.
const titleNS = (ns) => `${ns}@title`;
// Drop a title-only entry. Called when a full translation succeeds, so the
// newer full translation's title wins. Without this, a stale title-only
// result would keep overriding it (title cache has higher precedence).
const clearCachedTitle = (ns, id) => {
    const key = ck(titleNS(ns), id);
    translationMap.delete(key);
    dbDelete(key);
};
const getCachedTitle = (ns, id) => translationMap.get(ck(titleNS(ns), id)) ?? null;
const setCacheTitle  = (ns, id, t) => {
    const key = ck(titleNS(ns), id);
    translationMap.set(key, t);
    dbPut(key, t);
};

const clearNS = (ns, ids) => {
    ids.forEach(id => {
        [ck(ns, id), ck(titleNS(ns), id)].forEach(key => {
            translationMap.delete(key);
            dbDelete(key);
        });
    });
};

// Stats helper for UI
function getCacheStats() {
    let totalChars = 0;
    for (const v of translationMap.values()) totalChars += v.length;
    const bytes = totalChars * 2;  // UTF-16 approx
    const kb = bytes / 1024;
    const sizeStr = kb > 1024 ? `${(kb/1024).toFixed(2)} MB` : `${kb.toFixed(1)} KB`;
    return { count: translationMap.size, sizeStr };
}

// Instant rough estimate, shown while the real count is being fetched.
function estimateTokens(text) {
    if (!text) return 0;
    const cjk=(text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)||[]).length;
    return Math.ceil(cjk/1.5+(text.length-cjk)/4);
}

// SillyTavern removes {{// … }} comment macros before a prompt is sent, so
// they are left out of token counts (the displayed text is untouched).
// A comment is removed up to its matching }} — {{…}} nested inside it go with
// it. An unclosed comment is left as it is.
function stripMacroComments(text) {
    const s = String(text || '');
    if (!s.includes('{{//')) return s;
    let out = '', i = 0;
    while (i < s.length) {
        const start = s.indexOf('{{//', i);
        if (start < 0) { out += s.slice(i); break; }
        let depth = 0, j = start, end = -1;
        while (j < s.length - 1) {
            if (s[j] === '{' && s[j + 1] === '{') { depth++; j += 2; continue; }
            if (s[j] === '}' && s[j + 1] === '}') { depth--; j += 2; if (depth === 0) { end = j; break; } continue; }
            j++;
        }
        if (end < 0) { out += s.slice(i); break; }
        out += s.slice(i, start);
        i = end;
    }
    return out;
}

// Text that should be counted for an item. World info entries carry their
// keywords inside `content` for translation purposes; those marker lines are
// not part of the entry body ST actually injects, so they are excluded here.
// Comment macros are excluded too (see above).
const tokenTextOf = b => stripMacroComments((b && (b.tokenText ?? b.content)) || '');

// Accurate count via ST's tokenizer. getTokenCountAsync is the supported API;
// the sync getTokenCount is deprecated and only used as a fallback for older ST.
// Returns null when no tokenizer is available (caller keeps the estimate).
async function countTokensAccurate(text) {
    if (!text) return 0;
    try {
        const ctx = SillyTavern?.getContext?.();
        if (ctx && typeof ctx.getTokenCountAsync === 'function') return await ctx.getTokenCountAsync(text);
        if (ctx && typeof ctx.getTokenCount === 'function')      return ctx.getTokenCount(text);
    } catch (e) {}
    return null;
}

let isBusy=false, stopReq=false;
// The status line returns to "대기 중" three seconds after the last task ended.
// One timer for all tasks, and never while a task runs: an earlier task's
// timer used to cut a newer message short.
let _statusIdleTimer = null;
function statusIdleSoon() {
    clearTimeout(_statusIdleTimer);
    _statusIdleTimer = setTimeout(() => { const t = PDOC.getElementById('pt-status-text'); if (t && !isBusy) t.textContent = '대기 중'; }, 3000);
}

// ── Preset glossary ──────────────────────────────────────────────────
// Community slang common in (mostly Chinese) preset authoring.
//
// Scope: PRESET tab only. Many of these are ordinary words in story text
// (酒馆 is a real tavern in a fantasy scene, 盾 a real shield), so the glossary
// must never reach world info or character card translation.
//
// Storage: its own IndexedDB database. Kept apart from the translation cache
// so "전체 캐시 삭제" can't wipe it, and never written to settings.json.
//
// Line format:  term[/term...] = meaning | optional note
const DEFAULT_GLOSSARY = `# 프리셋 용어집 — 한 줄에 하나씩: 원어 = 뜻 | 메모(선택)
# 원어가 여러 개면 / 로 구분합니다. # 으로 시작하는 줄은 무시됩니다.
# 번역할 글에 실제로 등장하는 용어만 요청에 포함됩니다.
酒馆 = 실리태번(SillyTavern) | 소프트웨어를 가리킬 때만. 이야기 속 술집이면 그대로 번역
哈基米 = 제미나이(Gemini) | AI 모델을 가리킬 때
小克 / 克劳德 = 클로드(Claude) | AI 모델
牢大 = 클로드(Claude) | AI 모델을 가리킬 때만
预设 = 프리셋
世界书 = 월드인포(로어북)
正则 = 정규식
破限 / 越狱 / 破盾 / JB = 탈옥(제일브레이크) | 검열을 우회하는 프롬프트
盾 / 绿标 = 검열 필터 | 검열 맥락일 때만. 撞盾: 필터에 걸림
咒语 / 咏唱 = 프롬프트 | 프롬프트를 주문에 빗댄 표현
ERP / 涩涩 / 搞黄 = 성인 롤플레이(ERP)
语C = 텍스트 롤플레이
跑团 = TRPG(스토리 진행형 롤플레이)
捏人 / 设子 = 캐릭터 제작 | 봇·캐릭터 설정을 만드는 행위
降智 = 성능 저하 | 모델 응답 품질이 떨어지는 현상
复读机 = 반복 현상 | 같은 문장·표현을 되풀이하는 현상
脑补 = 할루시네이션 | 없는 내용을 멋대로 덧붙이는 현상`;

const META_DB_NAME = BUILD.metaDb;
const META_STORE   = 'kv';
const GLOSSARY_KEY = 'presetGlossary';

let _metaDbPromise = null;
function openMetaDB() {
    if (_metaDbPromise) return _metaDbPromise;
    _metaDbPromise = new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(META_DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
            req.onblocked = () => reject(new Error('meta db blocked'));
        } catch (e) { reject(e); }
    });
    // Allow a later retry if opening failed
    _metaDbPromise.catch(() => { _metaDbPromise = null; });
    return _metaDbPromise;
}
async function metaGet(key) {
    const db = await openMetaDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}
async function metaPut(key, value) {
    const db = await openMetaDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readwrite');
        tx.objectStore(META_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error);
    });
}

async function metaDelete(key) {
    const db = await openMetaDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readwrite');
        tx.objectStore(META_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error);
    });
}

// ── Preserved originals ───────────────────────────────────────────────
// One copy per preset name, taken from ST's SAVED preset (what is in the
// file) — never the unsaved working state. Connection fields (proxy URL,
// proxy password, custom endpoint …) are removed before anything is stored.
// Meta IndexedDB, kv store:
//   origIndex       [{ name, savedAt, source, size, count }]  small list
//   orig::{name}    { name, savedAt, source, body }            read only to compare / back up
//   origFp::{name}  [toggle identifiers]                        read only to look for a match
// Nothing reads the bodies at startup. Writes touch all three keys in one
// transaction, so the list never points at a missing copy.
const ORIG_INDEX_KEY = 'origIndex';
const origBodyKey = n => `orig::${n}`;
const origFpKey   = n => `origFp::${n}`;
const ORIG_SOURCE_LABEL = { preset: '직접 보존', import: '가져올 때 자동', file: '파일에서', backup: '백업에서' };
let ORIG_INDEX = null;                         // cached list once read
let _origIndexPromise = null;
const ORIG_LISTENERS = new Set();              // redraw hooks (compare tab, settings drawer)
const ORIG_FP_CACHE = new Map();               // name → toggle ids, filled by origFindFor
const origChanged = () => {
    ORIG_FP_CACHE.clear();
    ORIG_LISTENERS.forEach(fn => { try { fn(); } catch (e) { console.warn(`[${EXT}] original list redraw`, e); } });
};

function origIndexLoad() {
    if (ORIG_INDEX) return Promise.resolve(ORIG_INDEX);
    if (!_origIndexPromise) {
        _origIndexPromise = metaGet(ORIG_INDEX_KEY)
            // A write that finished first already holds the newer list
            .then(v => { if (!ORIG_INDEX) ORIG_INDEX = Array.isArray(v) ? v.filter(e => e && typeof e.name === 'string') : []; return ORIG_INDEX; })
            .catch(e => { console.warn(`[${EXT}] original list not read`, e); _origIndexPromise = null; return []; });
    }
    return _origIndexPromise;
}

// Deep copy without connection fields. The preset object itself is never changed.
function origStrip(preset) {
    const body = JSON.parse(JSON.stringify(preset || {}));
    for (const k of PRESET_CONNECTION_KEYS) delete body[k];
    return body;
}
const origIdsOf = body => presetItemsOf(body, true).map(it => it.id);
const isInstalledPreset = n => !!openai_setting_names && Object.prototype.hasOwnProperty.call(openai_setting_names, n);
const origSame = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; } };
const fmtBytes = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
const fmtDay = t => { const d = new Date(t), z = x => String(x).padStart(2, '0'); return `${d.getFullYear()}.${z(d.getMonth() + 1)}.${z(d.getDate())}`; };

async function origGet(name) {
    const rec = await metaGet(origBodyKey(name));
    return rec && typeof rec === 'object' && rec.body ? rec : null;
}

// Stores body (already stripped) under name, replacing any copy of that name.
async function origSave(name, body, source, savedAt = Date.now()) {
    const json = JSON.stringify(body);
    const entry = { name, savedAt, source, size: new Blob([json]).size, count: presetItemsOf(body, true).length };
    const ids = origIdsOf(body);
    const db = await openMetaDB();
    let next = null;
    await new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readwrite');
        const st = tx.objectStore(META_STORE);
        st.put({ name, savedAt, source, body }, origBodyKey(name));
        st.put(ids, origFpKey(name));
        const r = st.get(ORIG_INDEX_KEY);
        r.onsuccess = () => {
            const list = Array.isArray(r.result) ? r.result.filter(e => e && e.name !== name) : [];
            next = [entry, ...list];
            st.put(next, ORIG_INDEX_KEY);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
    ORIG_INDEX = next;
    origChanged();
    return entry;
}

async function origDelete(name) {
    const db = await openMetaDB();
    let next = null;
    await new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readwrite');
        const st = tx.objectStore(META_STORE);
        st.delete(origBodyKey(name));
        st.delete(origFpKey(name));
        const r = st.get(ORIG_INDEX_KEY);
        r.onsuccess = () => {
            next = Array.isArray(r.result) ? r.result.filter(e => e && e.name !== name) : [];
            st.put(next, ORIG_INDEX_KEY);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
    ORIG_INDEX = next;
    origChanged();
}

// Saves `body` as the original of `name`, asking before replacing a
// different copy. Returns 'saved' | 'same' | 'kept' (user said no).
async function origSaveAsking(name, body, source) {
    const list = await origIndexLoad();
    const had = list.find(e => e.name === name);
    if (had) {
        const old = await origGet(name);
        // Copies kept by older versions may still hold connection fields; compare without them
        if (old && origSame(origStrip(old.body), body)) return 'same';
        const how = ORIG_SOURCE_LABEL[had.source] ? ` (${ORIG_SOURCE_LABEL[had.source]})` : '';
        if (!confirm(`보존된 원본이 존재합니다. 덮어쓸까요?\n\n${name}\n보존한 날: ${fmtDay(had.savedAt)}${how}`)) return 'kept';
    }
    await origSave(name, body, source);
    return 'saved';
}

// 📥 on the preset tab
async function preserveOriginal(name) {
    const toast = (t, m) => { if (typeof toastr !== 'undefined') toastr[t](m); };
    const idx = openai_setting_names?.[name];
    const saved = (name && idx !== undefined) ? openai_settings?.[idx] : null;
    if (!saved) { toast('error', '실리태번에 저장된 프리셋을 찾지 못했어요'); return; }
    const body = origStrip(saved);
    let res;
    try { res = await origSaveAsking(name, body, 'preset'); }
    catch (e) { console.warn(`[${EXT}] preserve failed`, e); toast('error', '원본을 저장하지 못했어요 (브라우저 저장소 오류)'); return; }
    if (res === 'kept') return;
    if (res === 'same') { toast('info', '이미 같은 내용으로 보존되어 있어요'); return; }
    // The working state can hold edits that were never saved to the file
    let unsaved = false;
    try {
        unsaved = name === getCurrentPresetName() && !!oai_settings
            && !origSame([oai_settings.prompts, oai_settings.prompt_order], [saved.prompts, saved.prompt_order]);
    } catch (e) {}
    const e = ORIG_INDEX?.find(x => x.name === name);
    toast('success', `원본을 보존했어요${e ? ` (${fmtBytes(e.size)})` : ''}`
        + (unsaved ? '. 실리태번에 저장하지 않은 수정은 들어가지 않았어요' : ''));
}

// Best preserved original for preset `bName`: same name first, otherwise the
// copy sharing the most toggles (identifiers survive "save as"), with a small
// bonus when one name contains the other. Returns { pick, candidates }.
// ST's built-in slots (main, chatHistory …) are in every preset, so only the
// preset's own toggles count as evidence; without any, nothing is picked.
async function origFindFor(bName) {
    const list = await origIndexLoad();
    if (!list.length || !bName) return { pick: null, candidates: [] };
    const exact = list.find(e => e.name === bName);
    if (exact) return { pick: exact, candidates: [exact] };
    const T = readPresetToggles(bName);
    const mine = new Set((T?.items || []).map(it => it.id).filter(id => !PRESET_SYSTEM_IDS.has(id)));
    if (!mine.size) return { pick: null, candidates: [] };
    const norm = s => String(s).toLowerCase().replace(/[\s_\-.()[\]{}]+/g, '');
    const nb = norm(bName);
    const scored = [];
    for (const e of list) {
        let ids = ORIG_FP_CACHE.get(e.name);
        if (!ids) {
            try { ids = await metaGet(origFpKey(e.name)) || []; } catch (err) { ids = []; }
            ORIG_FP_CACHE.set(e.name, ids);
        }
        if (!Array.isArray(ids) || !ids.length) continue;
        const own = ids.map(String).filter(id => !PRESET_SYSTEM_IDS.has(id));
        if (!own.length) continue;
        let both = 0;
        for (const id of own) if (mine.has(id)) both++;
        if (!both) continue;
        const union = mine.size + own.length - both;
        const ne = norm(e.name);
        const bonus = (ne && nb && (nb.includes(ne) || ne.includes(nb))) ? 0.15 : 0;
        const score = (union ? both / union : 0) + bonus;
        if (score >= 0.3) scored.push({ e, score });
    }
    scored.sort((x, y) => y.score - x.score);
    const [first, second] = scored;
    const pick = first && first.score >= 0.5 && (!second || second.score < first.score - 0.1) ? first.e : null;
    return { pick, candidates: scored.map(x => x.e) };
}

// SillyTavern's own preset import (option, off by default). ST waits for its
// listeners before saving the import, so this only copies the data and does
// the storing afterwards without holding ST up. An existing original of the
// same name is never replaced automatically.
function onPresetImportReady(ev) {
    try {
        if (!cfg().autoPreserveImport) return;
        const name = ev?.presetName, data = ev?.data;
        if (!name || !data || typeof data !== 'object' || !Array.isArray(data.prompts)) return;
        const body = origStrip(data);
        (async () => {
            const list = await origIndexLoad();
            if (list.some(e => e.name === name)) {
                const old = await origGet(name);
                if (old && origSame(origStrip(old.body), body)) return;
                if (typeof toastr !== 'undefined') toastr.info(`'${name}'은(는) 보존된 원본이 이미 있어 자동 보존을 건너뛰었어요`);
                return;
            }
            await origSave(name, body, 'import');
            if (typeof toastr !== 'undefined') toastr.info(`'${name}' 원본을 자동으로 보존했어요`);
        })().catch(e => {
            console.warn(`[${EXT}] auto preserve failed`, e);
            if (typeof toastr !== 'undefined') toastr.warning(`'${name}' 원본을 자동으로 보존하지 못했어요 (브라우저 저장소 오류)`);
        });
    } catch (e) { console.warn(`[${EXT}] auto preserve`, e); }
}

// Effective glossary text: the built-in list until a saved copy is loaded.
let glossaryText = DEFAULT_GLOSSARY;
const glossaryReady = (async () => {
    try {
        const saved = await metaGet(GLOSSARY_KEY);
        if (typeof saved === 'string') glossaryText = saved;
    } catch (e) {
        console.warn(`[${EXT}] glossary load failed, using built-in list`, e);
    }
})();

// ── Custom endpoint ──────────────────────────────────────────────────
// An address as SillyTavern expects it: no trailing slash and without
// /chat/completions (its server adds that).
const tidyUrl = u => String(u || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
const customUrl = () => tidyUrl(cfg().customUrl);
// A key typed in the panel stays in this browser (IndexedDB), never in
// settings.json, and is not part of any backup.
const CUSTOM_KEY = 'customKey';
let customKey = '';
const customKeyReady = (async () => {
    try {
        const saved = await metaGet(CUSTOM_KEY);
        if (typeof saved === 'string') customKey = saved;
    } catch (e) {
        console.warn(`[${EXT}] custom endpoint key could not be read`, e);
    }
})();
// With no key typed, a key SillyTavern already holds for the SAME address is
// used. SillyTavern keeps one saved key per connection profile and, asked
// without one, would use only whichever is active at the moment.
//   - a connection profile of the Custom kind: its saved secret, by id (the
//     server looks the value up; it never reaches the browser)
//   - a reverse-proxy preset, or the reverse proxy in use: its password
//   - SillyTavern's own Custom connection, when it points at this address:
//     its active key
// Only an exact address match counts, so a key is never sent anywhere but the
// site it was saved for. Returns null when nothing is saved for the address.
// Letter case is ignored in the scheme and host only: a path may tell
// tenants of one host apart.
const siteOf = u => { const t = tidyUrl(u); try { return tidyUrl(new URL(t).href); } catch (e) { return t; } };
function savedKeyFor(url) {
    if (!url) return null;
    const here = siteOf(url), same = u => !!u && siteOf(u) === here;
    try {
        const cm = extension_settings.connectionManager, held = stSecrets?.secret_state?.api_key_custom;
        const alive = id => !Array.isArray(held) || held.some(x => x && x.id === id);   // the secret was not deleted since
        const fits = (Array.isArray(cm?.profiles) ? cm.profiles : []).filter(p => p && p.api === 'custom' && p['secret-id'] && same(p['api-url']) && alive(p['secret-id']));
        const prof = fits.find(p => p.id === cm.selectedProfile) || fits[0];
        if (prof) return { secretId: prof['secret-id'], from: `연결 프로필 "${prof.name}"의 키` };
        const preset = (Array.isArray(stOpenai?.proxies) ? stOpenai.proxies : []).find(x => x && x.password && same(x.url));
        if (preset) return { key: preset.password, from: `프록시 프리셋 "${preset.name}"의 비밀번호` };
        if (oai_settings?.proxy_password && same(oai_settings.reverse_proxy)) return { key: oai_settings.proxy_password, from: '실리태번에 설정된 리버스 프록시 비밀번호' };
        const hasActive = Array.isArray(held) ? held.some(x => x && x.active) : !!held;
        if (hasActive && same(oai_settings?.custom_url)) return { active: true, from: '실리태번 Custom 연결의 현재 키' };
    } catch (e) { console.warn(`[${EXT}] saved key lookup failed`, e); }
    return null;
}
// Puts the address and the key on a request for the Custom endpoint.
// Returns a few words on which key is used, for the settings screen.
function customAuth(body) {
    const asHeader = key => { body.custom_include_headers = JSON.stringify({ Authorization: 'Bearer ' + key }); };
    body.custom_url = customUrl();
    if (customKey) { asHeader(customKey); return '입력한 키'; }
    const saved = savedKeyFor(body.custom_url);
    // Nothing saved for this address: send no key. Left alone, SillyTavern
    // would attach its active Custom key, which belongs to some other site.
    if (!saved) { asHeader(''); return '키 없음'; }
    if (saved.secretId) body.secret_id = saved.secretId;
    else if (!saved.active) asHeader(saved.key);   // active: SillyTavern attaches it itself
    return saved.from;
}
// Model names the address reports (SillyTavern asks <address>/models). Kept
// for this session only; also the quickest way to see that address and key work.
let customModels = [];
async function fetchCustomModels() {
    await customKeyReady;
    const body = { chat_completion_source: 'custom' }, keyUsed = customAuth(body);
    if (!body.custom_url) throw new Error('주소를 먼저 입력해 주세요');
    const res = await fetch('/api/backends/chat-completions/status', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    let d = null;
    try { d = await res.json(); } catch (e) {}
    const names = Array.isArray(d?.data) ? d.data.map(m => m && m.id).filter(x => typeof x === 'string' && x) : [];
    if (!names.length) throw new Error(`모델 목록을 받지 못했습니다 (사용: ${keyUsed}). 주소와 키를 확인해 주세요. 목록을 주지 않는 서버라면 모델명을 직접 입력하세요`);
    return { names, keyUsed };
}

function parseGlossary(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const terms = line.slice(0, eq).split('/').map(t => t.trim()).filter(Boolean);
        let meaning = line.slice(eq + 1).trim();
        let note = '';
        const bar = meaning.indexOf('|');
        if (bar >= 0) { note = meaning.slice(bar + 1).trim(); meaning = meaning.slice(0, bar).trim(); }
        if (!terms.length || !meaning) continue;
        out.push({ terms, meaning, note });
    }
    return out;
}

let _glossaryParsed = [], _glossaryParsedFrom = null;
function getGlossary() {
    if (_glossaryParsedFrom !== glossaryText) {
        _glossaryParsed = parseGlossary(glossaryText);
        _glossaryParsedFrom = glossaryText;
    }
    return _glossaryParsed;
}

// ASCII terms (JB, ERP) match as whole words, case-sensitively, so "ERP"
// never fires on "interpret". Everything else is a plain substring match.
function glossaryTermIn(term, text) {
    if (/^[A-Za-z0-9_]+$/.test(term)) {
        return new RegExp(`(^|[^A-Za-z0-9_])${term}(?![A-Za-z0-9_])`).test(text);
    }
    return text.includes(term);
}

// Only entries whose term actually appears in the text are sent. This keeps
// requests small and avoids nudging the model toward terms that aren't there.
function buildGlossaryBlock(sourceText) {
    const text = String(sourceText || '');
    const hits = getGlossary().filter(e => e.terms.some(t => glossaryTermIn(t, text)));
    if (!hits.length) return '';
    const lines = hits.map(e => `- ${e.terms.join(' / ')} → ${e.meaning}${e.note ? ` (${e.note})` : ''}`);
    return `GLOSSARY — community slang found in this text. Use a meaning only when the term is used in that sense; otherwise translate it normally.\n${lines.join('\n')}`;
}

const PRESET_CONTEXT = 'Context: The text below comes from a SillyTavern prompt preset for AI roleplay. It contains instructions written for an AI model, and notes written for the preset\'s users.';
const presetNameRules = (first) =>
`${first}. Names of AI models, companies and tools (Claude, Opus, Sonnet, Fable, Gemini, GPT, DeepSeek, SillyTavern...) are proper nouns. Never translate them by their dictionary meaning — "Fable" is a model, not a story; "Gemini" is a model, not a zodiac sign.
${first + 1}. Copy version numbers and model codes exactly as written ("45o", "3.1", "v1.8"). Never expand, correct, or guess them. If you cannot tell what a term refers to, keep it in its original script.`;

// ── Translation ─────────────────────────────────────────────────
async function translateText(name, text, extraNonce, kind) {
    const hasName    = !!(name && name.trim());
    const hasContent = !!(text && text.trim());
    // Nothing translatable at all → skip
    if (!hasName && !hasContent) return '';
    const lang = effLang();
    // Compose what we send to the model:
    //   - name + content → "### {name}\n\n{content}"
    //   - name only     → "### {name}"   (title-only translation)
    //   - content only  → "{content}"
    const combined = hasName && hasContent
        ? `### ${name}\n\n${text}`
        : (hasName ? `### ${name}` : text);

    const isPreset = kind === 'preset';
    if (isPreset) { try { await glossaryReady; } catch (e) {} }
    const glossaryBlock = isPreset ? buildGlossaryBlock(combined) : '';
    const rulesBlock =
`Translate the following text into ${lang}.

RULES:
1. Translate ALL human-readable text including headings, labels, titles, and body content.
2. Do NOT translate: HTML/XML tags, {{char}}, {{user}}, {{getvar::*}}, {{setvar::*}}, {{random::*}}, regex patterns, JSON keys, code, URLs, emoji.
3. Do NOT alter references to languages, nationalities, cultures, or styles. For example: if the source says "Chinese style" or "中文风格" or "중국식", translate those words literally — do NOT replace them with the target language name.
4. Preserve all markdown, whitespace, indentation, and line breaks exactly.
5. Output ONLY the translated text — no preamble, no "Here is:", no meta-commentary.
6. Never echo the source text back unchanged. Even if the source is already close to ${lang}, produce a proper ${lang} rendering.
7. If a line starts with "**Keys:**" or "**Filters:**", keep that exact prefix and the comma-separated list format, and keep it on its own line at the top. Translate each item into ${lang}. These are trigger keywords, so render them as the natural word a reader would actually type, not as a literal gloss.${isPreset ? '\n' + presetNameRules(8) + '\n10. These are instructions for an AI. Keep their strength: must / never / only / always stay equally strong. Do not soften, summarize, or reinterpret them.' : ''}`;

    // Sections joined by a blank line. For world info / character cards this
    // yields exactly the previous prompt; the retry marker now sits before the
    // source so the final line stays the target-language instruction.
    const parts = [];
    if (isPreset) parts.push(PRESET_CONTEXT);
    parts.push(rulesBlock);
    if (extraNonce) parts.push(`<!--retry:${extraNonce}-->`);
    if (glossaryBlock) parts.push(glossaryBlock);
    parts.push(`--- SOURCE ---\n${combined}\n--- END ---`);
    parts.push(`Now output the above text translated into ${lang}.`);
    const prompt = parts.join('\n\n');

    const r = await callModel([{ role: 'user', content: prompt }], { prefill: true, vary: !!extraNonce });
    if (!r.text) throw new Error(r.cut ? '출력 한도에 걸려 빈 응답이 왔습니다' : '빈 응답을 받았습니다');
    const result = r.text.replace(/^---\s*SOURCE\s*---\s*\n?/i,'').replace(/\n?---\s*END\s*---\s*$/i,'').trim();
    if (r.cut) {
        // Never stored as a finished translation; the caller may show it as a preview
        const e = new Error('출력 한도에 걸려 번역이 잘렸습니다. 저장하지 않았어요');
        e.partial = result;
        throw e;
    }
    return result;
}

// ── Preset ────────────────────────────────────────────────────────────
function listAllPresets() {
    if (!openai_settings||!openai_setting_names) return [];
    return Object.keys(openai_setting_names).filter(n=>openai_settings[openai_setting_names[n]]).map(n=>({id:n,name:n}));
}
function getCurrentPresetName() {
    if (oai_settings?.preset_settings_openai) return oai_settings.preset_settings_openai;
    for (const s of ['#settings_preset','#preset_name_select','select[name="preset_name"]']) {
        const el=document.querySelector(s); if(!el) continue;
        const txt=el.options[el.selectedIndex]?.text?.trim(); if(txt&&txt!=='—') return txt;
    }
    return '';
}
// ST's built-in prompt slots. Their identifiers are fixed, unlike custom
// toggles whose identifiers are random and sometimes reused by preset authors.
const PRESET_SYSTEM_IDS = new Set(['main','worldInfoBefore','worldInfoAfter','charDescription','charPersonality','scenario','personaDescription','enhanceDefinitions','nsfw','dialogueExamples','chatHistory','jailbreak']);

function readPresetBlocks(presetName) {
    const blocks=[];
    try {
        const cur=getCurrentPresetName();
        let preset=(!presetName||presetName===cur)?oai_settings:openai_settings[openai_setting_names[presetName]];
        if (!preset) return blocks;
        const prompts=preset.prompts||[];
        const allOrders=preset.prompt_order||[];
        const charOrder=allOrders.find(o=>String(o.character_id)==='100001')||allOrders.find(o=>String(o.character_id)==='100000')||allOrders[0];
        const order=charOrder?.order||[];
        const map=Object.fromEntries(prompts.map(p=>[p.identifier,p]));
        for (const entry of order) {
            const p=map[entry.identifier]; if(!p) continue;
            blocks.push({ id:p.identifier, name:p.name||p.identifier, enabled:entry.enabled!==false, content:p.content||'', isCustom:!PRESET_SYSTEM_IDS.has(p.identifier) });
        }
    } catch(e) { console.warn(`[${EXT}]`,e); }
    return blocks;
}

// ── World Info ────────────────────────────────────────────────────────
function listAllWorldInfos() {
    const items=[];
    try {
        if (Array.isArray(world_names)&&world_names.length) { world_names.forEach(n=>{if(n)items.push({id:n,name:n});}); return items; }
        const sel=document.querySelector('#world_editor_select');
        if (sel) Array.from(sel.options).forEach(o=>{const v=(o.value||o.textContent||'').trim();if(v)items.push({id:v,name:v});});
    } catch(e){}
    return items;
}
// Marker used to carry world-info keywords through the translation round-trip.
const KEYS_MARKER = '**Keys:**';
const FILTERS_MARKER = '**Filters:**';

// Pull the "**Keys:** a, b, c" line out of a body.
// Returns { keys: string[]|null, body } — keys is null when the line is absent,
// in which case callers keep the original keywords untouched.
function splitKeysAndBody(text) {
    if (typeof text !== 'string' || !text) return { keys: null, filters: null, body: text || '' };
    const lines = text.split(/\r?\n/);
    const parseList = v => {
        const out = v.split(/[,，]/).map(k => k.trim()).filter(Boolean);
        return out.length ? out : null;
    };
    let keys = null, filters = null, consumed = -1;
    // Both marker lines sit in the leading block, in either order, possibly
    // separated by blank lines. Scanning stops at the first content line.
    for (let i = 0; i < lines.length && i < 6; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '') continue;
        // Accepts "**Keys:** a, b" / "**Keys**: a, b" / "Keys: a, b" / "Keys： a, b"
        const mk = trimmed.match(/^\*{0,2}\s*Keys\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*(.*?)\s*\*{0,2}$/i);
        if (mk) { keys = parseList(mk[1]); consumed = i; continue; }
        const mf = trimmed.match(/^\*{0,2}\s*Filters?\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*(.*?)\s*\*{0,2}$/i);
        if (mf) { filters = parseList(mf[1]); consumed = i; continue; }
        break;
    }
    if (consumed < 0) return { keys: null, filters: null, body: text };
    const body = lines.slice(consumed + 1).join('\n').replace(/^(\s*\r?\n)+/, '');
    return { keys, filters, body };
}

// Compact, display-only metadata for a world-info entry.
function readEntryMeta(e) {
    if (!e) return null;
    const posMap = { 0:'↑Char', 1:'↓Char', 2:'↑AN', 3:'↓AN', 4:'@D', 5:'↑EM', 6:'↓EM' };
    const pos = posMap[e.position] ?? (e.position != null ? String(e.position) : '');
    const strat = e.constant ? 'const' : (e.vectorized ? 'vector' : 'normal');
    // Numbers only: a shared file can hold anything in these fields, and they
    // end up in the panel's markup (see makeBlockItem)
    const num = v => {
        const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
        return Number.isFinite(n) ? n : null;
    };
    return {
        strategy: strat,
        position: pos,
        depth: (e.position === 4) ? num(e.depth) : null,
        order: num(e.order),
        probability: (e.useProbability === false) ? null : num(e.probability),
    };
}

async function readWorldInfo(wiName) {
    const entries=[];
    if (!wiName) return entries;
    try {
        const ctx=SillyTavern.getContext();
        let bookData=null;
        if (typeof ctx.loadWorldInfo==='function') bookData=await ctx.loadWorldInfo(wiName);
        if (!bookData?.entries&&world_info?.[wiName]?.entries) bookData=world_info[wiName];
        if (!bookData?.entries) return entries;
        const rawEntries=Object.entries(bookData.entries);
        rawEntries.sort((a,b)=>Number(a[1]?.uid??a[0])-Number(b[1]?.uid??b[0]));
        for (const [uid,e] of rawEntries) {
            const keys = Array.isArray(e.key) ? e.key.filter(k => String(k||'').trim()) : [];
            const filters = Array.isArray(e.keysecondary) ? e.keysecondary.filter(k => String(k||'').trim()) : [];
            // Keywords and the optional filter ride along inside the translated
            // body as leading marker lines — the same trick already used for
            // titles. This keeps one translation unit per entry, so cache keys,
            // progress, search and 👀 all stay unchanged.
            const body = e.content || '';
            const header = [];
            if (keys.length)    header.push(`${KEYS_MARKER} ${keys.join(', ')}`);
            if (filters.length) header.push(`${FILTERS_MARKER} ${filters.join(', ')}`);
            const content = header.length ? `${header.join('\n')}\n\n${body}` : body;
            entries.push({
                id: `${wiName}::${uid}`,
                name: e.comment || `Entry ${uid}`,
                enabled: !e.disable,
                content,
                tokenText: body,          // counted without the Keys/Filters lines
                meta: readEntryMeta(e),
            });
        }
    } catch(e) { console.warn(`[${EXT}]`,e); }
    return entries;
}

// ── Characters ──────────────────────────────────────────────────
function listAllCharacters() {
    let arr=[];
    try { if(Array.isArray(characters)&&characters.length) arr=characters; } catch(e){}
    if (!arr.length) { try { arr=SillyTavern.getContext().characters||[]; } catch(e){} }
    if (!arr.length) {
        try {
            const blocks=document.querySelectorAll('#rm_print_characters_block .character_select');
            const items=[];
            blocks.forEach(el=>{
                const name=el.querySelector('.ch_name')?.textContent?.trim()||'';
                const avatar=el.getAttribute('avatar')||el.dataset.avatar||'';
                const id=avatar||el.getAttribute('chid')||el.dataset.chid||'';
                if(id&&name)items.push({id,name});
            });
            return items;
        } catch(e){}
    }
    // Use avatar filename as stable ID (survives array reindexing when characters are deleted)
    return arr
        .map((c,i)=>({ id: c?.avatar || `_idx${i}`, name: c?.name || c?.data?.name || `#${i}` }))
        .filter(c=>c.name);
}

// Avatar file of the character in the open chat, or ''
function currentCharAvatar() {
    try {
        const ctx = SillyTavern.getContext();
        const cid = ctx.characterId;
        if (cid == null) return '';
        return (ctx.characters?.[cid] || characters?.[cid])?.avatar || '';
    } catch (e) { return ''; }
}

// Find character array index given avatar filename (or fallback to number id)
function findCharIndex(avatarOrId) {
    if (!Array.isArray(characters)) return -1;
    // First try: match by avatar
    let idx = characters.findIndex(c => c?.avatar === avatarOrId);
    if (idx >= 0) return idx;
    // Fallback: if it's numeric (legacy behavior), treat as index
    const n = Number(avatarOrId);
    if (!Number.isNaN(n) && n >= 0 && n < characters.length) return n;
    return -1;
}

async function readCharCard(charIdOrAvatar) {
    const fields=[];
    try {
        const idx = findCharIndex(charIdOrAvatar);
        if (idx < 0) return fields;
        if (typeof unshallowCharacter==='function') {
            try { await unshallowCharacter(idx); } catch(e) {}
        }
        let char=null;
        if (Array.isArray(characters)&&characters[idx]) char=characters[idx];
        if (!char) char=SillyTavern.getContext().characters?.[idx];
        if (!char) return fields;
        const d=char.data||{};
        const add=(id,label,val)=>{ if(val&&String(val).trim()) fields.push({id,name:label,content:String(val),isChar:true}); };

        add('description',               '📄 Description',          d.description    || char.description);
        add('personality',               '🎭 Personality Summary',  d.personality    || char.personality);
        add('scenario',                  '🌐 Scenario',             d.scenario       || char.scenario);
        add('first_mes',                 '💬 First Greeting',       d.first_mes      || char.first_mes);
        add('mes_example',               '📝 Examples of Dialogue', d.mes_example    || char.mes_example);
        add('system_prompt',             '⚙️ System Prompt',        d.system_prompt);
        // Character's Note (inline injection) = extensions.depth_prompt.prompt
        const depthPrompt = d.extensions?.depth_prompt?.prompt || d.character_note || '';
        add('character_note',            "📌 Character's Note",     depthPrompt);
        add('post_history_instructions', '📌 Post History Instr.',  d.post_history_instructions);
        add('creator_notes',             '📋 Creator Notes',        d.creator_notes);
        const alts=d.alternate_greetings||char.alternate_greetings||[];
        alts.forEach((g,i)=>{ if(g&&String(g).trim()) fields.push({id:`alt_greeting_${i}`,name:`💬 Alternate Greeting ${i+1}`,content:String(g),isChar:true}); });
    } catch(e) { console.warn(`[${EXT}]`,e); }
    return fields;
}

// ── UI ────────────────────────────────────────────────────────────────
// Escapes text for safe insertion into both HTML text nodes and quoted
// attribute values. Quotes matter: prompt/entry names are placed into
// title="..." attributes, and an unescaped quote there would let a crafted
// name break out of the attribute.
const esc = s => (s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');

// Search keyword highlight
function highlightText(html, keyword) {
    if (!keyword) return html;
    // The box holds escaped HTML, so match against the escaped keyword.
    const safeK = esc(keyword).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    // Keyword first, then tags/entities. At a tag or entity boundary the second
    // branch consumes the whole token, so a keyword can never land inside
    // <span class="..."> or split an entity like &#39;.
    const re = new RegExp(`(${safeK})|(<[^>]*>|&(?:#\\d+|#x[0-9a-f]+|[a-z]+);)`, 'gi');
    return html.replace(re, (m, hit, skip) => hit ? `<mark class="pt-highlight">${hit}</mark>` : skip);
}

function makeBlockItem(block, ns, selectable) {
    const el = PDOC.createElement('div');
    el.className = 'pt-block-item';
    el.dataset.id = block.id;
    const cached = getCached(ns, block.id);
    const tokens = block._tok ?? estimateTokens(tokenTextOf(block));
    el.dataset.searchText = (block.name+' '+(block.content||'')+' '+(cached||'')).toLowerCase();

    // Use ST native FA link icon
    const clipBadge = block.isCustom
        ? `<span class="pt-clip-badge"><i class="fa-solid fa-link"></i></span>` : '';

    // Character cards: no ON/OFF badge
    const statusBadge = block.isChar
        ? ''
        : `<span class="pt-status-badge ${block.enabled!==false?'pt-status-on':'pt-status-off'}">${block.enabled!==false?'ON':'OFF'}</span>`;

    // Select-all checkbox when selectable
    const checkboxHtml = selectable ? `<input type="checkbox" class="pt-checkbox">` : '';

    // Compact metadata strip (world info only). Display-only, never translated.
    const m = block.meta;
    let metaHtml = '';
    if (m) {
        const dot = m.strategy === 'const' ? '🔵' : (m.strategy === 'vector' ? '🔗' : '🟢');
        const bits = [`${dot}`];
        if (m.position)             bits.push(`pos ${esc(m.position)}`);
        if (m.depth != null)        bits.push(`depth ${esc(String(m.depth))}`);
        if (m.order != null)        bits.push(`order ${esc(String(m.order))}`);
        if (m.probability != null && m.probability !== 100) bits.push(`trig ${esc(String(m.probability))}%`);
        metaHtml = `<div class="pt-block-meta">${bits.join('<span class="pt-meta-sep">·</span>')}</div>`;
    }

    el.innerHTML = `
        <div class="pt-block-header">
            ${checkboxHtml}
            ${statusBadge}
            <span class="pt-block-name" title="${esc(block.name)}">${esc(block.name)}</span>
            ${clipBadge}
            <span class="pt-token-count">${tokens}</span>
            <span class="pt-block-chevron">▶</span>
        </div>
        <div class="pt-block-body">
            ${metaHtml}
            <div class="pt-original-label">원문</div>
            <div class="pt-original-text">${esc(block.content||'')}</div>
            <div class="pt-translated-label">번역</div>
            <div class="pt-translated-text">${cached?esc(cached):'<span class="pt-no-trans">번역 전</span>'}</div>
        </div>`;

    el.querySelector('.pt-block-header').addEventListener('click', e => {
        if (e.target.classList.contains('pt-checkbox')) return;
        el.classList.toggle('expanded');
    });
    if (selectable) {
        el.querySelector('.pt-checkbox')?.addEventListener('change', ev => {
            el.classList.toggle('selected', ev.target.checked);
            const page = el.closest('.pt-page');
            if (page) updateSelectedCount(page);
        });
    }
    return el;
}

// Selected chip shows count + token sum
function updateSelectedCount(page) {
    const selectedItems = [...page.querySelectorAll('.pt-block-list .pt-block-item.selected')];
    const count = selectedItems.length;
    const el = page.querySelector('.pt-selected-chip');
    if (!el) return;
    if (count > 0) {
        // 토큰 합계 계산
        const totalTkn = selectedItems.reduce((s, item) => {
            const tkEl = item.querySelector('.pt-token-count');
            return s + (parseInt(tkEl?.textContent || '0') || 0);
        }, 0);
        el.textContent = `선택: ${count}개  ${totalTkn.toLocaleString()} tkn`;
        el.style.display = '';
    } else {
        el.style.display = 'none';
    }
}

function setBlockHTML(list, id, htmlContent) {
    const item = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!item) return;
    const ta = item.querySelector('.pt-translated-text');
    if (ta) {
        ta.innerHTML = htmlContent;
        // Drop any search snapshot: it holds the pre-update content, and clearing
        // the search box would otherwise restore that stale version.
        delete ta.dataset.origHtml;
    }
    if (typeof htmlContent === 'string') {
        // Always use the original name for search indexing.
        // When the 👀 toggle is ON, the displayed name may be the translated title,
        // but data-orig-name still holds the original — fall back to current text if absent.
        const namePart = item.dataset.origName || item.querySelector('.pt-block-name')?.textContent || '';
        const origPart = item.querySelector('.pt-original-text')?.textContent||'';
        const transPart = ta?.textContent||'';
        item.dataset.searchText = (namePart+' '+origPart+' '+transPart).toLowerCase();
    }
}

// ── Translation runner ─────────────────────────────────────────────────
// `targets` (optional): items picked by the caller; otherwise the selection in
// `list`, or everything. Items with `titleOnly` (bundled regex) are translated
// first, as names only, in batches — exactly like 📛 — and `onTitles` then
// shows them. `onDone` runs when everything has finished.
// isShown (optional): false once the page shows another item, so results of
// this run are no longer painted into a list they do not belong to.
async function runTranslation({ items, list, ns, pBar, pLabel, pWrap, btnStop, forceRetranslate, kind, targets: picked, onTitles, onDone, isShown }) {
    if (isBusy) return;
    let targets = picked;
    if (!targets) {
        const selected=[...list.querySelectorAll('.pt-block-item.selected')].map(el=>el.dataset.id);
        targets=selected.length?items.filter(b=>selected.includes(b.id)):items;
    }
    const titleOnly = targets.filter(b => b.titleOnly);
    targets = targets.filter(b => !b.titleOnly);
    // An empty item whose name the panel supplies itself (ST's default slots
    // such as Chat History, Korean target) has nothing to translate: no request.
    const own = targets.filter(b => !String(b.content || '').trim() && builtinTitle(ns, b.id, b.name));
    if (own.length) targets = targets.filter(b => !own.includes(b));
    const titleTodo = forceRetranslate ? titleOnly : titleOnly.filter(b => !getTranslatedTitle(ns, b.id, b.name));
    if (!targets.length && !titleTodo.length && own.length) {
        if (typeof toastr !== 'undefined') toastr.info('기본 항목 이름은 번역 없이 바로 보여 드려요');
        return;
    }

    isBusy=true; stopReq=false;
    const dot=PDOC.getElementById('pt-status-dot'), stTxt=PDOC.getElementById('pt-status-text');
    dot?.classList.add('busy');
    if (stTxt) stTxt.textContent = forceRetranslate?'재번역 중...':'번역 중...';
    pWrap.classList.add('visible');
    if (btnStop) btnStop.disabled=false;
    const paint = (id, html) => { if (!isShown || isShown()) setBlockHTML(list, id, html); };
    const total=targets.length+titleTodo.length; let done=0;
    const step = (n) => {
        done += n;
        const pct = total ? Math.round(done/total*100) : 100;
        pBar.style.width=pct+'%';
        pLabel.textContent=`${done} / ${total}  (${pct}%)`;
    };

    let fails = 0;   // items that got no new translation (shown in the status line and a toast)
    let nameFails = 0, nameErr = '';   // of those, names translated in batches: they have no cell to show a reason in
    // Names only, batched (bundled regex)
    const bs = titleBatchSize();
    for (let i = 0; i < titleTodo.length && !stopReq; i += bs) {
        const batch = titleTodo.slice(i, i + bs);
        try {
            const tr = await translateTitleBatch(batch.map(b => b.name), kind);
            if (tr) batch.forEach((b, k) => setCacheTitle(ns, b.id, tr[k]));
            else { fails += batch.length; nameFails += batch.length; if (!nameErr) nameErr = BATCH_MISMATCH; console.warn(`[${EXT}] title batch discarded (reply did not match ${batch.length} items)`); }
        } catch (err) { fails += batch.length; nameFails += batch.length; if (!nameErr) nameErr = String(err?.message || err); console.warn(`[${EXT}] title batch failed`, err); }
        step(batch.length);
        if (!stopReq) await new Promise(r=>setTimeout(r, requestDelayMs()));
    }
    if (titleOnly.length && typeof onTitles === 'function') onTitles();

    // A re-translation keeps the old translation until a new one arrives, so
    // a failed request (network, rate limit, error reply, reply cut by the
    // output limit) never loses it. A cut reply is never stored; it is only
    // shown as a preview when there is no old translation.
    let keptOnFail = 0;
    for (const b of targets) {
        if (stopReq) break;
        const old = getCached(ns, b.id);
        if (old && !forceRetranslate) {
            paint(b.id, esc(old));
        } else {
            paint(b.id, '<span class="pt-translating">⟳ 번역 중...</span>');
            try {
                const nonce=forceRetranslate?Math.random().toString(36).slice(2,10):null;
                const res=await translateText(b.name,b.content,nonce,kind);
                if (res) {
                    paint(b.id, esc(res));
                    setCache(ns,b.id,res);
                    // Full translation is the newer action — retire the
                    // title-only entry so its title isn't stuck winning.
                    clearCachedTitle(ns,b.id);
                } else {
                    // Both name and content were empty — nothing to translate
                    paint(b.id, old ? esc(old) : '<span class="pt-no-trans">번역 전</span>');
                }
            } catch(err) {
                const msg = `<span style="color:#ef4444;font-size:11px;">❌ ${esc(err.message)}${old ? ' — 기존 번역을 그대로 두었어요' : ''}</span>`;
                const below = old || err.partial || '';
                paint(b.id, below ? `${msg}\n${esc(below)}` : msg);
                fails++;
                if (old) keptOnFail++;
            }
        }
        step(1);
        if (!stopReq) await new Promise(r=>setTimeout(r, requestDelayMs()));
    }
    if (fails && typeof toastr !== 'undefined') {
        toastr.warning(`번역 ${fails}개 실패${keptOnFail ? ` — 기존 번역 ${keptOnFail}개는 그대로 두었어요` : ''}.`
            + (fails > nameFails ? ' 해당 항목에 이유가 표시됩니다.' : '')
            + (nameFails ? ` 이름 ${nameFails}개: ${shortReason(nameErr)}` : ''));
    }
    try { updateCacheStatsUI(); } catch(e) {}
    isBusy=false;
    dot?.classList.remove('busy');
    const doneWord = forceRetranslate ? '재번역' : '번역';
    if (stTxt) stTxt.textContent = stopReq ? '중단됨' : (fails ? `${doneWord} 끝 · 실패 ${fails}개` : `${doneWord} 완료 ✓`);
    pWrap.classList.remove('visible');
    if (btnStop) btnStop.disabled=true;
    if (typeof onDone === 'function') onDone();
    statusIdleSoon();
}

// ── Export Module ───────────────────────────────────────────

// Sanitize filename: remove forbidden chars but keep unicode (Korean/Chinese OK)
function sanitizeFilename(name) {
    return String(name || 'untitled')
        .replace(/[\/\\:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 80);
}

// Trigger browser download of a Blob
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

// Generic N-choice modal. opts = [{ v:'value', label:'표시 텍스트' }, ...]
// Resolves to the chosen value, or null if cancelled / dismissed.
function askChoice(title, opts) {
    return new Promise(resolve => {
        const existing = PDOC.getElementById('pt-choice-modal');
        if (existing) existing.remove();

        const backdrop = PDOC.createElement('div');
        backdrop.id = 'pt-choice-modal';
        backdrop.className = 'pt-choice-backdrop';
        backdrop.innerHTML = `
          <div class="pt-choice-box" role="dialog" aria-modal="true">
            <div class="pt-choice-title">${esc(title)}</div>
            <div class="pt-choice-btns">
              ${opts.map(o => `<button type="button" data-v="${esc(o.v)}">${esc(o.label)}</button>`).join('')}
            </div>
            <div class="pt-choice-cancel"><button type="button" data-v="__cancel__">취소</button></div>
          </div>`;
        const panel = PDOC.getElementById('pt-panel');
        (panel || PDOC.body).appendChild(backdrop);

        const close = (val) => { backdrop.remove(); resolve(val); };
        backdrop.addEventListener('click', e => {
            if (e.target === backdrop) return close(null);
            const btn = e.target.closest('button[data-v]');
            if (!btn) return;
            const v = btn.dataset.v;
            close(v === '__cancel__' ? null : v);
        });
    });
}

function askTextChoice(title) {
    return new Promise(resolve => {
        const existing = PDOC.getElementById('pt-choice-modal');
        if (existing) existing.remove();

        const backdrop = PDOC.createElement('div');
        backdrop.id = 'pt-choice-modal';
        backdrop.className = 'pt-choice-backdrop';
        backdrop.innerHTML = `
          <div class="pt-choice-box" role="dialog" aria-modal="true">
            <div class="pt-choice-title">${esc(title)}</div>
            <div class="pt-choice-btns">
              <button type="button" data-v="original">원문만</button>
              <button type="button" data-v="translated">번역문만</button>
              <button type="button" data-v="both">둘 다</button>
            </div>
            <div class="pt-choice-cancel"><button type="button" data-v="cancel">취소</button></div>
          </div>`;
        // mount to panel if exists, else body
        const panel = PDOC.getElementById('pt-panel');
        (panel || PDOC.body).appendChild(backdrop);

        const close = (val) => { backdrop.remove(); resolve(val); };
        backdrop.addEventListener('click', e => {
            if (e.target === backdrop) close(null); // click outside = cancel
            const btn = e.target.closest('button[data-v]');
            if (!btn) return;
            const v = btn.dataset.v;
            close(v === 'cancel' ? null : v);
        });
    });
}

// Format text for export/copy according to choice
function formatItemsAsText(items, choice) {
    const out = [];
    for (const it of items) {
        const original   = (it.content || '').trim();
        const translated = (getCached(it._ns, it.id) || '').trim();
        const name = it.name || it.id || '';

        if (choice === 'original') {
            out.push(`━━━ ${name} ━━━\n${original}`);
        } else if (choice === 'translated') {
            out.push(`━━━ ${name} ━━━\n${translated || '(번역없음)'}`);
        } else { // both
            const t = translated || '(번역없음)';
            out.push(`━━━ ${name} ━━━\n[원문]\n${original}\n\n[번역]\n${t}`);
        }
    }
    return out.join('\n\n');
}

// Copy text to clipboard with fallback
async function copyTextToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch(e) {}
    // fallback
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch(e) { return false; }
}

// Deep clone via structured JSON (ST data is JSON-safe)
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// Get translation for a given namespace + id (returns null if not translated)
function getTranslated(ns, id) {
    return getCached(ns, id);
}

// Split a translated content into { title, body }.
// During translation we prepend "### {title}\n\n" so the model also translates
// the toggle/entry name. The model output may include markdown separators (---)
// before/around the heading, so we scan the first few non-empty lines for the
// first markdown heading and treat everything before it as discardable preamble.
function splitTitleAndBody(translated) {
    if (typeof translated !== 'string' || !translated) return { title: null, body: translated || '' };

    const lines = translated.split(/\r?\n/);
    let scanned = 0;
    for (let i = 0; i < lines.length && scanned < 5; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === '') continue; // skip leading blank lines
        scanned++;
        // Skip horizontal-rule separators (--- *** ___) that the model sometimes emits
        if (/^([-*_]){3,}$/.test(trimmed)) continue;
        // Match a markdown heading line
        const m = trimmed.match(/^#{1,6}\s+(.+?)\s*$/);
        if (m) {
            const title = m[1].trim();
            // Body = everything after this heading line, with leading blank lines stripped
            let body = lines.slice(i + 1).join('\n');
            body = body.replace(/^(\s*\r?\n)+/, '');
            return { title, body };
        }
        // Hit a non-heading content line — no title prefix detected
        break;
    }
    return { title: null, body: translated };
}

// Helper used by JSON exporters: returns the translated body (without the prepended title line).
// If no translation exists, returns null.
function getTranslatedBody(ns, id) {
    const t = getTranslated(ns, id);
    if (!t) return null;
    return splitTitleAndBody(t).body;
}

// ST's built-in prompt slots. SillyTavern shows the stored name as-is in every
// UI language, so a slot that still has its default English name stays English
// even in a Korean UI. For those, the panel supplies the Korean name itself
// (no request needed). Slots renamed by the preset author are translated as
// usual. Default names per SillyTavern's PromptManager, including older ones.
const BUILTIN_SLOT_TITLES_KO = {
    'Main Prompt': '메인 프롬프트',
    'Auxiliary Prompt': '보조 프롬프트',
    'NSFW Prompt': 'NSFW 프롬프트',
    'Post-History Instructions': '기록 후 지시문',
    'Jailbreak Prompt': '탈옥 프롬프트',
    'Enhance Definitions': '정의 강화',
    'Chat Examples': '대화 예시',
    'Chat History': '대화 내역',
    'World Info (before)': '월드인포(이전)',
    'World Info (after)': '월드인포(이후)',
    'Char Description': '캐릭터 설명',
    'Char Personality': '캐릭터 성격',
    'Scenario': '시나리오',
    'Persona Description': '페르소나 설명',
};
const isKoTarget = () => /^(korean|한국어|ko)$/i.test(effLang().trim());
const isDefaultSlotName = (id, name) =>
    PRESET_SYSTEM_IDS.has(String(id)) && Object.prototype.hasOwnProperty.call(BUILTIN_SLOT_TITLES_KO, String(name || '').trim());
const builtinSlotTitle = (id, name) =>
    (isKoTarget() && isDefaultSlotName(id, name)) ? BUILTIN_SLOT_TITLES_KO[String(name).trim()] : null;

// Character card items are always ST's own fields (see readCharCard), so the
// panel names them itself — never a request, never borrowed from another card.
// Wording follows SillyTavern's Korean UI where it has one.
const BUILTIN_CHAR_FIELDS_KO = {
    description: '📄 캐릭터 설명',
    personality: '🎭 성격 요약',
    scenario: '🌐 시나리오',
    first_mes: '💬 첫 메시지',
    mes_example: '📝 대화 예시',
    system_prompt: '⚙️ 시스템 프롬프트',
    character_note: '📌 캐릭터 노트',
    post_history_instructions: '📌 기록 후 지시문',
    creator_notes: '📋 제작자 메모',
};
const builtinCharField = (id) => {
    if (!isKoTarget()) return null;
    const m = String(id).match(/^alt_greeting_(\d+)$/);
    if (m) return `💬 대체 인사말 ${Number(m[1]) + 1}`;
    return Object.prototype.hasOwnProperty.call(BUILTIN_CHAR_FIELDS_KO, String(id)) ? BUILTIN_CHAR_FIELDS_KO[String(id)] : null;
};
// The name the panel supplies without a request, or null
const builtinTitle = (ns, id, name) => {
    if (String(ns).startsWith('pt-char::')) return builtinCharField(id);
    if (String(ns).startsWith('pt-preset::') && name != null) return builtinSlotTitle(id, name);
    return null;
};

// Helper: returns only the translated title (or null if not found in the translation).
// `name` (optional, the toggle's current name) enables the built-in names of
// ST's default prompt slots for presets.
function getTranslatedTitle(ns, id, name) {
    // Character card fields always use the panel's own names
    const charField = String(ns).startsWith('pt-char::') ? builtinCharField(id) : null;
    if (charField) return charField;
    // Precedence: the title-only cache wins when present.
    // It is only ever written by an explicit "제목만" action (which skips
    // items that already have a title, unless the user confirms a redo),
    // so its presence always reflects a deliberate user choice — including
    // a redo meant to override a bad title from a full translation.
    const only = getCachedTitle(ns, id);
    if (only && only.trim()) return only.trim();

    // Otherwise use the title embedded in a full translation.
    const t = getTranslated(ns, id);
    if (t) {
        const title = splitTitleAndBody(t).title;
        if (title) return title;
    }
    // Built-in name of a default ST slot (presets only)
    if (name != null && String(ns).startsWith('pt-preset::')) return builtinSlotTitle(id, name);
    return null;
}

// ── JS-Slash-Runner script export (preset titles) ─────────────────────
// Builds a script that renames prompt-manager entries in ST's own UI to the
// translated titles. It only rewrites what is displayed — the preset itself
// is never touched, and disabling the script in JS Runner puts the original
// names back (the script cleans up when its frame is removed).
//
// Matching is by exact name string. We deliberately do NOT include a
// substring-matching fallback: with entries like "NSFW" and "NSFW 기초"
// present, fuzzy matching silently assigns the wrong translation.
function buildTitleScriptContent(label, mapping, kind) {
    const json = JSON.stringify(mapping, null, 2);

    if (kind === 'wi') {
        // World Info entry titles live inside <input>/<textarea> elements in ST's
        // World Info editor. Writing to their .value would fire ST's change
        // handlers and could persist the translated title into the user's actual
        // world info data. So this script NEVER touches input values — it only
        // appends a separate hint element next to the field. Removing the script
        // (or reloading) leaves the data untouched.
        return `/**
 * World Info Title Hints — ${label}
 * Generated by Prompt Panel.
 *
 * Shows a translated title next to each World Info entry name.
 *
 * SAFETY: this script never writes to any input/textarea value. It only
 * inserts read-only hint elements, so your world info data is never modified.
 * Turning the script off removes the hints.
 *
 * Note: this relies on SillyTavern's internal DOM (world info editor markup).
 * A future SillyTavern update could change it and stop this script from
 * taking effect. It will fail silently, never destructively.
 */

const TRANSLATIONS = ${json};

const targetDoc = parent.document || document;
const HINT_CLASS = "ppt-wi-hint";
const STYLE_ID = "ppt-wi-hint-style";
const TITLE_FIELDS = 'input[name="comment"], textarea[name="comment"]';

// The editor draws its entries inside this element, so only it is watched and
// searched. If a future SillyTavern has no such element, the whole page is
// used instead (ignoring the chat log).
const listRoot = targetDoc.getElementById("world_popup_entries_list");
const root = listRoot || targetDoc.body;

// Title field -> its hint. Kept here so no search through the page is needed.
const hints = new WeakMap();

// Exact match only — no substring fallback.
function findTranslation(original) {
  if (!original) return null;
  return Object.prototype.hasOwnProperty.call(TRANSLATIONS, original)
    ? TRANSLATIONS[original]
    : null;
}

function injectStyle() {
  if (targetDoc.getElementById(STYLE_ID)) return;
  const style = targetDoc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = "." + HINT_CLASS + " { display: block; width: 100%; flex: 0 0 100%;"
    + " margin: 0 0 2px 0; font-size: 0.85em; line-height: 1.3; opacity: 0.7;"
    + " pointer-events: none; overflow-wrap: anywhere; }";
  targetDoc.head.appendChild(style);
}

// Where the hint goes is decided by measurement, not by guessing at CSS: it is
// put before the field, and while it still shares a line with the field
// (flex/grid row, float, etc.) it is lifted one level up, a few times. This is
// done once, when the hint is created; a hint that is already in place is
// never measured again.
function sharesLine(hint, field) {
  try {
    const h = hint.getBoundingClientRect();
    const f = field.getBoundingClientRect();
    if (!h.height || !f.height) return false;
    return h.bottom > f.top + 1 && h.top < f.bottom - 1;
  } catch (e) { return false; }
}
function placeHint(hint, field) {
  let anchor = field;
  anchor.insertAdjacentElement("beforebegin", hint);
  for (let i = 0; i < 4 && sharesLine(hint, field); i++) {
    const up = anchor.parentElement;
    if (!up || up === root || up === targetDoc.body) break;
    anchor = up;
    anchor.insertAdjacentElement("beforebegin", hint);
  }
}

function applyHints() {
  root.querySelectorAll(TITLE_FIELDS).forEach((field) => {
    // Read only. Never assign to field.value.
    const translated = findTranslation((field.value || "").trim());
    let hint = hints.get(field);
    if (hint && !hint.isConnected) hint = null;

    if (!translated) {
      if (hint) hint.remove();
      hints.delete(field);
      return;
    }
    const text = "→ " + translated;
    if (hint) {
      if (hint.textContent !== text) hint.textContent = text;
      return;
    }
    // Not drawn yet (editor closed): wait until it is, so the position can be measured.
    if (!field.getClientRects().length) return;
    hint = targetDoc.createElement("div");
    hint.className = HINT_CLASS;
    hint.textContent = text;
    placeHint(hint, field);
    hints.set(field, hint);
  });
}

let rafId = null;
function scheduleApply() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    // Detach while we mutate so our own insertions can never re-trigger us.
    observer.disconnect();
    try {
      applyHints();
    } finally {
      observer.observe(root, { childList: true, subtree: true });
    }
  });
}

// Only used when the whole page is watched: chat streaming rewrites the chat
// log constantly, and none of those changes can affect entry titles.
function onlyChatChanged(records) {
  const chat = targetDoc.getElementById("chat");
  if (!chat) return false;
  for (const r of records) {
    if (!chat.contains(r.target)) return false;
  }
  return true;
}

const observer = new MutationObserver((records) => {
  if (!listRoot && onlyChatChanged(records)) return;
  scheduleApply();
});
// The entry list changing size means it was opened, closed or redrawn.
const sizeWatch = typeof ResizeObserver === "function" && listRoot ? new ResizeObserver(scheduleApply) : null;
// A title edited by hand: its hint follows.
function onTitleInput(e) {
  if (e.target && e.target.name === "comment") scheduleApply();
}

// Turning the script off removes its frame: take the hints away with it.
let stopped = false;
function cleanup() {
  if (stopped) return;
  stopped = true;
  observer.disconnect();
  if (sizeWatch) sizeWatch.disconnect();
  if (rafId !== null) cancelAnimationFrame(rafId);
  root.removeEventListener("input", onTitleInput, true);
  targetDoc.querySelectorAll("." + HINT_CLASS).forEach((h) => h.remove());
  const style = targetDoc.getElementById(STYLE_ID);
  if (style) style.remove();
}

function init() {
  // Hints left behind by an earlier copy of this script
  targetDoc.querySelectorAll("." + HINT_CLASS).forEach((h) => h.remove());
  injectStyle();
  observer.observe(root, { childList: true, subtree: true });
  if (sizeWatch) sizeWatch.observe(listRoot);
  root.addEventListener("input", onTitleInput, true);
  window.addEventListener("pagehide", cleanup);
  window.addEventListener("unload", cleanup);
  applyHints();
}

if (targetDoc.readyState === "loading") {
  targetDoc.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
`;
    }

    return `/**
 * Prompt Name Translator — ${label}
 * Generated by Prompt Panel.
 *
 * Shows translated names for the prompt entries in SillyTavern's prompt
 * manager. Display only — the preset data is never modified. Turning this
 * script off in JS Runner puts the original names back.
 *
 * Note: this relies on SillyTavern's internal DOM (prompt manager markup).
 * A future SillyTavern update could change it and stop this script from
 * taking effect.
 */

const TRANSLATIONS = ${json};

const targetDoc = parent.document || document;
const SELECT_ID = "completion_prompt_manager_footer_append_prompt";

// Exact match only — no substring fallback (see header note).
function findTranslation(original) {
  if (!original) return null;
  return Object.prototype.hasOwnProperty.call(TRANSLATIONS, original)
    ? TRANSLATIONS[original]
    : null;
}

let rafId = null;
function scheduleApply() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => { rafId = null; applyAllTranslations(); });
}

// A name is replaced only while it still shows the original. Text that is
// neither the original nor this script's translation was put there by
// something else (for example another translation add-on) and is left alone,
// so two add-ons can never keep overwriting each other.

// Prompt list entries: the title attribute holds the original name
function applyListTranslations() {
  targetDoc.querySelectorAll("a.prompt-manager-inspect-action").forEach((el) => {
    const original = el.getAttribute("title") || "";
    const translated = findTranslation(original.trim());
    if (translated && el.textContent === original) el.textContent = translated;
  });
}

// "Add prompt" dropdown at the bottom of the prompt manager
function applySelectTranslations() {
  const select = targetDoc.getElementById(SELECT_ID);
  if (!select) return;
  select.querySelectorAll("option").forEach((option) => {
    if (option.dataset.pptOriginal !== undefined) return;   // renamed already
    const original = option.textContent.trim();
    const translated = findTranslation(original);
    if (!translated) return;
    option.dataset.pptOriginal = original;
    option.textContent = translated;
  });
}

function applyAllTranslations() {
  applyListTranslations();
  applySelectTranslations();
}

// Chat streaming rewrites the chat log constantly, and none of those changes
// can affect prompt-manager titles. Ignore any batch that happened entirely
// inside the chat log, so the script stays idle while you chat.
function onlyChatChanged(records) {
  const chat = targetDoc.getElementById("chat");
  if (!chat) return false;
  for (const r of records) {
    if (!chat.contains(r.target)) return false;
  }
  return true;
}

const observer = new MutationObserver((records) => {
  if (onlyChatChanged(records)) return;
  scheduleApply();
});

// Turning the script off removes its frame: put the original names back,
// but only where the screen still shows this script's translation.
let stopped = false;
function restore() {
  if (stopped) return;
  stopped = true;
  observer.disconnect();
  if (rafId !== null) cancelAnimationFrame(rafId);
  targetDoc.querySelectorAll("a.prompt-manager-inspect-action").forEach((el) => {
    const original = el.getAttribute("title") || "";
    const translated = findTranslation(original.trim());
    if (translated && el.textContent === translated) el.textContent = original;
  });
  targetDoc.querySelectorAll("#" + SELECT_ID + " option[data-ppt-original]").forEach((option) => {
    const original = option.dataset.pptOriginal;
    if (option.textContent === findTranslation(original)) option.textContent = original;
    delete option.dataset.pptOriginal;
  });
}

function init() {
  observer.observe(targetDoc.body, { childList: true, subtree: true });
  window.addEventListener("pagehide", restore);
  window.addEventListener("unload", restore);
  applyAllTranslations();
}

if (targetDoc.readyState === "loading") {
  targetDoc.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
`;
}

// kind: 'preset' | 'wi'
function exportTitleScript(kind, srcName, items, ns) {
    let targetName = srcName;
    if (kind === 'preset' && (srcName === '__cur__' || !srcName)) {
        targetName = oai_settings?.preset_settings_openai || '';
    }

    const mapping = {};
    let skipped = 0;
    for (const b of (items || [])) {
        const original = (b.name || '').trim();
        if (!original) continue;
        const translated = getTranslatedTitle(ns, b.id, b.name);
        if (!translated || translated === original) { skipped++; continue; }
        // Duplicate original names collapse into one entry — unavoidable,
        // since the generated script matches on the displayed name.
        mapping[original] = translated;
    }

    const count = Object.keys(mapping).length;
    if (!count) {
        throw new Error('번역된 제목이 없습니다. 먼저 번역 또는 "제목만" 번역을 실행하세요.');
    }

    const label = targetName || (kind === 'wi' ? 'World Info' : 'Preset');
    const content = buildTitleScriptContent(label, mapping, kind);

    let uuid;
    try { uuid = crypto.randomUUID(); }
    catch (e) { uuid = 'ppt-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 10); }

    const data = {
        type: 'script',
        enabled: true,
        name: `(제목번역) ${label}`,
        id: uuid,
        content,
        info: `Prompt Panel이 생성한 제목 번역 스크립트 (${count}개 항목, ${effLang()})`,
        button: { enabled: true, buttons: [] },
        data: {},
    };

    return {
        data,
        filename: `${sanitizeFilename(label)}_titles_${effLang()}_jsrunner.json`,
        count,
        skipped,
    };
}

// API connection / endpoint / credential fields of a preset.
// These are machine-specific and may include secrets: exports strip them, and
// the preset compare never reads or shows them.
const PRESET_CONNECTION_KEYS = [
    'custom_url', 'custom_model', 'custom_include_body', 'custom_exclude_body',
    'custom_include_headers', 'custom_prompt_post_processing',
    'reverse_proxy', 'proxy_password',
    'vertexai_region', 'vertexai_auth_mode', 'vertexai_express_project_id',
    'vertexai_template', 'vertexai_model',
    'openrouter_model', 'openrouter_use_fallback', 'openrouter_group_models',
    'openrouter_sort_models', 'openrouter_providers', 'openrouter_allow_fallbacks',
    'openrouter_middleout', 'openrouter_api_key',
    'openai_model', 'claude_model', 'google_model', 'ai21_model', 'mistralai_model',
    'cohere_model', 'perplexity_model', 'groq_model', 'deepseek_model',
    'zerooneai_model', 'nanogpt_model', 'blockentropy_model', 'xai_model',
    'chat_completion_source',
    'api_url_scale', 'bypass_status_check',
    // ST treats these as sensitive too (its own export asks before keeping them)
    'azure_base_url', 'azure_deployment_name', 'azure_api_version', 'azure_openai_model',
    'workers_ai_account_id', 'workers_ai_model',
];
// ST marks its own connection fields in settingsToUpdate (4th value true).
// Reading that list at start-up also covers providers ST adds later; the
// list above stays as the fallback for ST versions that do not export it.
function addConnectionKeysFromSt(settingsToUpdate) {
    try {
        if (!settingsToUpdate || typeof settingsToUpdate !== 'object') return;
        for (const [presetKey, v] of Object.entries(settingsToUpdate)) {
            if (!Array.isArray(v) || v[3] !== true) continue;
            for (const k of [presetKey, v[1]]) {
                if (typeof k !== 'string' || !k) continue;
                if (!PRESET_CONNECTION_KEYS.includes(k)) PRESET_CONNECTION_KEYS.push(k);
                DIFF_SKIP_KEYS.add(k);
            }
        }
    } catch (e) { console.warn(`[${EXT}] connection field list not read`, e); }
}

// ── JSON Export: Preset ───────────────────────────────────────────────
// Returns ST-compatible preset JSON with translated toggle contents.
// Strips API connection/endpoint settings (they shouldn't be shared with translations).
function exportPresetJSON(presetName) {
    const targetName = presetName === '__cur__' || !presetName
        ? (oai_settings?.preset_settings_openai || '')
        : presetName;
    if (!targetName) throw new Error('프리셋을 찾을 수 없습니다');

    // Structure comes from the SAVED preset (openai_settings[]), which holds only
    // preset fields. oai_settings is ST's whole live chat-completion state and
    // also carries connection settings, so cloning it wholesale could leak them.
    // For the currently loaded preset we then overlay just what the panel shows —
    // prompts and prompt_order — from the live state, so unsaved edits still
    // match what the user saw.
    const cur = getCurrentPresetName();
    const presetIndex = openai_setting_names?.[targetName];
    const saved = presetIndex !== undefined ? openai_settings[presetIndex] : null;
    const isCurrent = targetName === cur && oai_settings;

    let cloned;
    if (saved) {
        cloned = deepClone(saved);
        if (isCurrent) {
            if (Array.isArray(oai_settings.prompts))      cloned.prompts      = deepClone(oai_settings.prompts);
            if (Array.isArray(oai_settings.prompt_order)) cloned.prompt_order = deepClone(oai_settings.prompt_order);
        }
    } else if (isCurrent) {
        // No saved copy to base on (e.g. never saved). Fall back to the live
        // state; PRESET_CONNECTION_KEYS below removes the known connection fields.
        cloned = deepClone(oai_settings);
    } else {
        throw new Error('프리셋 객체를 찾을 수 없습니다');
    }
    const ns = `pt-preset::${presetName || '__cur__'}`;

    // Strip the connection fields (PRESET_CONNECTION_KEYS); they should never be
    // embedded in a translated preset file meant for sharing.
    for (const k of PRESET_CONNECTION_KEYS) delete cloned[k];

    // Also strip the entire connection profile if present
    if (cloned.connection_profile) delete cloned.connection_profile;

    // Note: extensions object is preserved (contains regex_scripts and other useful settings)

    // Replace prompt contents and names with translations where available
    if (Array.isArray(cloned.prompts)) {
        for (const p of cloned.prompts) {
            if (!p || !p.identifier) continue;
            const cached = getTranslated(ns, p.identifier);
            // Title may come from a title-only translation even when there is
            // no full translation, so resolve it independently of the body.
            const title = getTranslatedTitle(ns, p.identifier, p.name);
            if (title) p.name = title;
            if (!cached) continue;
            const { body } = splitTitleAndBody(cached);
            if (typeof body === 'string') p.content = body;
        }
    }
    return { data: cloned, filename: `${sanitizeFilename(targetName)}_${effLang()}.json` };
}

// ── JSON Export: World Info ───────────────────────────────────────────
// selectedIds: null = all entries, Set = only those entries (others stay original)
async function exportWorldInfoJSON(worldName, selectedIds) {
    const ctx = SillyTavern?.getContext?.() || getContext?.();
    if (!ctx?.loadWorldInfo) throw new Error('WI 로드 함수를 찾을 수 없습니다');
    const wi = await ctx.loadWorldInfo(worldName);
    if (!wi || !wi.entries) throw new Error('WI 데이터를 찾을 수 없습니다');

    const cloned = deepClone(wi);
    const ns = `pt-wi::${worldName}`;

    // ST's loadWorldInfo() sometimes attaches an `originalData` field that
    // contains a backup of all entries in the original (array) shape. This
    // field is NOT part of the standard WI export format and we must remove
    // it — otherwise filtered exports still contain the full original list,
    // and the file is bloated with duplicated content.
    if ('originalData' in cloned) delete cloned.originalData;

    // If partial selection, filter entries to only selected ones
    if (selectedIds instanceof Set && selectedIds.size > 0) {
        const filteredEntries = {};
        let kept = 0;
        for (const key of Object.keys(cloned.entries)) {
            const entry = cloned.entries[key];
            if (!entry) continue;
            // Try multiple id formats since uid could be number or string
            const candidates = [
                `${worldName}::${entry.uid}`,
                `${worldName}::${String(entry.uid)}`,
                `${worldName}::${key}`,
            ];
            if (candidates.some(c => selectedIds.has(c))) {
                filteredEntries[key] = entry;
                kept++;
            }
        }
        cloned.entries = filteredEntries;
        console.log(`[${EXT}] WI export: filtered ${kept}/${selectedIds.size} entries`);
    }

    // Apply translations (id format matches readWorldInfo: "{wiName}::{uid}")
    for (const key of Object.keys(cloned.entries)) {
        const entry = cloned.entries[key];
        if (!entry) continue;
        const entryId = `${worldName}::${entry.uid ?? key}`;
        const cached = getTranslated(ns, entryId);
        const title = getTranslatedTitle(ns, entryId);
        if (title) entry.comment = title;
        if (!cached) continue;
        const { body: afterTitle } = splitTitleAndBody(cached);
        const parsed = splitKeysAndBody(afterTitle);
        // Guard against false positives: only honour a marker line if the
        // original entry actually had that field. Otherwise a body that
        // genuinely starts with "**Keys:**" would be mis-read as metadata.
        const hadKeys    = Array.isArray(entry.key) && entry.key.length > 0;
        const hadFilters = Array.isArray(entry.keysecondary) && entry.keysecondary.length > 0;
        const keys    = hadKeys    ? parsed.keys    : null;
        const filters = hadFilters ? parsed.filters : null;
        // If a marker was parsed but the original had no such field, that line
        // was real content — put it back so nothing is lost.
        let body = parsed.body;
        if ((parsed.keys && !hadKeys) || (parsed.filters && !hadFilters)) body = afterTitle;
        if (typeof body === 'string') entry.content = body;

        const mergeList = (orig, added) => {
            const out = [], seen = new Set();
            for (const k of [...(Array.isArray(orig) ? orig : []), ...added]) {
                const v = String(k || '').trim();
                if (!v || seen.has(v)) continue;
                seen.add(v);
                out.push(v);
            }
            return out;
        };

        // Primary keys use "any one matches" semantics, so merging original and
        // translated terms is always safe and lets the entry fire either way.
        if (keys && keys.length) entry.key = mergeList(entry.key, keys);

        // Secondary keys depend on selectiveLogic (ST world_info_logic):
        //   0 AND_ANY  — any secondary matches      → merging is safe
        //   1 NOT_ALL  — blocked only if ALL match  → merging breaks the block
        //   2 NOT_ANY  — blocked if any match       → merging is safe (and desirable)
        //   3 AND_ALL  — ALL secondaries must match → merging kills the entry
        // For the two "ALL" logics, extra terms change the condition itself, so
        // we replace with the translated terms instead of merging. The exported
        // card is meant to be used in the target language, so the translated
        // terms are the ones that should apply.
        if (filters && filters.length) {
            const logic = Number(entry.selectiveLogic ?? 0);
            const isAllLogic = (logic === 1 || logic === 3);
            entry.keysecondary = isAllLogic ? filters.slice() : mergeList(entry.keysecondary, filters);
        }
    }
    return { data: cloned, filename: `${sanitizeFilename(worldName)}_${effLang()}.json` };
}

// ── JSON Export: Character Card ───────────────────────────────────────
// selectedIds: null = translate all fields, Set = only apply translation to those field ids
async function exportCharacterJSON(charIdRaw, opts, selectedIds) {
    let idx = -1;
    if (charIdRaw === '__cur__' || charIdRaw === undefined || charIdRaw === null || charIdRaw === '') {
        const ctx = SillyTavern?.getContext?.() || getContext?.();
        idx = ctx?.characterId !== undefined ? Number(ctx.characterId) : -1;
    } else {
        idx = findCharIndex(charIdRaw);
    }
    if (idx < 0 || !characters?.[idx]) throw new Error('캐릭터를 찾을 수 없습니다');

    try { await unshallowCharacter?.(idx); } catch(e) {}
    const char = characters[idx];
    if (!char) throw new Error('캐릭터 데이터 없음');

    const cloned = deepClone(char);

    // Namespace matches page load: pt-char::{avatar}
    const ns = `pt-char::${char.avatar || '_idx' + idx}`;

    // Strip ST runtime metadata (not part of proper character card export)
    const RUNTIME_KEYS = ['chat', 'chat_size', 'data_size', 'date_added', 'date_last_chat', 'json_data', 'shallow'];
    for (const k of RUNTIME_KEYS) delete cloned[k];

    const shouldApply = (fieldId) => !(selectedIds instanceof Set) || selectedIds.size === 0 || selectedIds.has(fieldId);
    const isPartial = selectedIds instanceof Set && selectedIds.size > 0;

    // V3 spec uses data.* as source of truth. V1 top-level fields are duplicates.
    // We write translations into V2 (data.*) only and clear V1 duplicates to keep file lean.
    const setV2 = (v2Key, value) => {
        if (value === undefined || value === null) return;
        if (cloned.data) cloned.data[v2Key] = value;
    };

    const mainFields = [
        'description', 'personality', 'scenario', 'first_mes', 'mes_example',
        'post_history_instructions', 'creator_notes',
    ];

    // Apply translations to V2; clear non-selected fields when partial selection is active
    for (const f of mainFields) {
        if (shouldApply(f)) {
            const t = getTranslatedBody(ns, f);
            if (t !== null) setV2(f, t);
        } else if (isPartial) {
            setV2(f, '');
        }
    }

    // Clear V1 duplicates (description, personality, etc. at top level)
    const V1_DUPLICATES = ['description', 'personality', 'scenario', 'first_mes', 'mes_example',
                           'post_history_instructions', 'creator_notes', 'system_prompt',
                           'creator', 'character_version'];
    for (const k of V1_DUPLICATES) {
        if (k in cloned) cloned[k] = '';
    }

    // Alternate greetings: V2 is source of truth
    const alts = cloned.data?.alternate_greetings || cloned.alternate_greetings || null;
    if (Array.isArray(alts)) {
        for (let i = 0; i < alts.length; i++) {
            const fieldId = `alt_greeting_${i}`;
            if (shouldApply(fieldId)) {
                const t = getTranslatedBody(ns, fieldId);
                if (t !== null) alts[i] = t;
            } else if (isPartial) {
                alts[i] = '';
            }
        }
        if (cloned.data) cloned.data.alternate_greetings = alts;
        if ('alternate_greetings' in cloned) cloned.alternate_greetings = [];
    }

    // Character's Note: V2 path only
    if (shouldApply('character_note')) {
        const noteT = getTranslatedBody(ns, 'character_note');
        if (noteT && cloned.data?.extensions?.depth_prompt) {
            cloned.data.extensions.depth_prompt.prompt = noteT;
        }
    } else if (isPartial && cloned.data?.extensions?.depth_prompt) {
        cloned.data.extensions.depth_prompt.prompt = '';
    }

    // system_prompt
    if (shouldApply('system_prompt')) {
        const t = getTranslatedBody(ns, 'system_prompt');
        if (t && cloned.data) cloned.data.system_prompt = t;
    } else if (isPartial && cloned.data) {
        cloned.data.system_prompt = '';
    }

    // Embedded character_book: option A — keep original. If excluded, remove ALL world link refs.
    if (opts && opts.includeCharacterBook === false) {
        // Remove the embedded book itself
        if (cloned.data?.character_book) delete cloned.data.character_book;
        if (cloned.character_book) delete cloned.character_book;
        // Remove world-info name references — ST auto-links a same-named world info on import,
        // which defeats the "exclude" intent.
        if (cloned.data?.extensions) {
            if ('world' in cloned.data.extensions) cloned.data.extensions.world = '';
        }
        if (cloned.extensions) {
            if ('world' in cloned.extensions) cloned.extensions.world = '';
        }
        // Some cards also carry a top-level reference
        if ('world' in cloned) cloned.world = '';
        if (cloned.data && 'world' in cloned.data) cloned.data.world = '';
    }

    const name = char.name || `character_${idx}`;
    return { data: cloned, filename: `${sanitizeFilename(name)}_${effLang()}.json` };
}

// ── Title-only translation (batched) ─────────────────────────────────
// Translates just the toggle/entry names, in batches, so a user can skim a
// large preset and decide what is worth translating in full.
//
// Safety notes:
//  - Results go to the title-only cache (titleNS), never to the main cache,
//    so a later full 번역 still runs normally and is never shadowed.
//  - Items that already have a translated title (full or title-only) are
//    skipped, so repeat presses cost nothing and never overwrite good data.
//  - Parsing is strict: a batch whose reply doesn't line up 1:1 is discarded
//    wholesale rather than risk assigning titles to the wrong toggles.
// Batch size and inter-request delay are user-configurable (extension drawer).
const titleBatchSize  = () => Math.max(1, Math.min(50, cfg().titleBatchSize || 15));
const requestDelayMs  = () => Math.max(0, cfg().requestDelayMs ?? 60);

function parseNumberedTitles(raw, expectedCount) {
    if (typeof raw !== 'string') return null;
    const found = new Map();
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s*[.):\]]\s*(.+?)\s*$/);
        if (!m) continue;
        const idx = parseInt(m[1], 10);
        let val = m[2].trim();
        // Strip stray markdown emphasis/heading the model may add
        val = val.replace(/^#{1,6}\s+/, '').replace(/^\*\*(.*)\*\*$/, '$1').trim();
        if (!val) continue;
        if (idx >= 1 && idx <= expectedCount && !found.has(idx)) found.set(idx, val);
    }
    // Require a complete, unambiguous mapping
    if (found.size !== expectedCount) return null;
    const out = [];
    for (let i = 1; i <= expectedCount; i++) out.push(found.get(i));
    return out;
}

// kind: 'preset' | 'wi' | 'char' — toggle / entry / field titles
//       'names-preset' | 'names-wi' | 'names-char' — names of the items themselves
async function translateTitleBatch(names, kind) {
    const lang = effLang();
    const numbered = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
    const nameKind = (/^names-(preset|wi|char)$/.exec(kind) || [])[1] || '';
    const isPreset = kind === 'preset' || nameKind === 'preset';
    if (isPreset) { try { await glossaryReady; } catch (e) {} }
    const glossaryBlock = isPreset ? buildGlossaryBlock(names.join('\n')) : '';
    const NAME_WHAT = { preset: 'SillyTavern prompt presets', wi: 'SillyTavern world info (lorebook) books', char: 'SillyTavern character cards' };
    const rule1 = nameKind
        ? `These are names of ${NAME_WHAT[nameKind]}, as listed in a menu. Keep them short and name-like.`
          + (nameKind === 'char' ? ` A person's or character's name is written the way it is usually written in ${lang} (by its sound), not translated by its meaning; descriptive titles are translated.` : '')
        : 'These are UI labels / section titles from a chat-AI prompt preset. Keep them short and label-like.';
    const rule7 = nameKind
        ? `A proper noun that is normally left as it is in ${lang} may stay unchanged.`
        : `Never echo a label back unchanged. Even if a label is already close to ${lang}, produce a proper ${lang} rendering.`;
    const rulesBlock =
`Translate each of the following ${names.length} short ${nameKind ? 'names' : 'labels'} into ${lang}.

RULES:
1. ${rule1}
2. Do NOT translate: {{char}}, {{user}}, {{getvar::*}}, {{setvar::*}}, {{random::*}}, code identifiers, URLs.
3. Preserve any leading emoji or symbols exactly as they appear.
4. Do NOT alter references to languages, nationalities, cultures, or styles. Translate such words literally.
5. Output EXACTLY ${names.length} lines, each formatted as "<number>. <translation>", in the same order and numbering as the input.
6. Output ONLY those lines — no preamble, no commentary, no blank lines between items.
7. ${rule7}${(isPreset || nameKind) ? '\n' + presetNameRules(8) : ''}`;

    const parts = [];
    if (kind === 'preset') parts.push(PRESET_CONTEXT);
    parts.push(rulesBlock);
    if (glossaryBlock) parts.push(glossaryBlock);
    parts.push(`--- LABELS ---\n${numbered}\n--- END ---`);
    parts.push(`Now output the ${names.length} numbered lines, translated into ${lang}.`);
    const prompt = parts.join('\n\n');

    const r = await callModel([{ role: 'user', content: prompt }], { prefill: true });
    // A list cut by the output limit may still look complete: discard it
    if (r.cut) throw new Error('출력 한도에 걸려 목록이 잘렸습니다');
    return parseNumberedTitles(r.text, names.length);
}

// Batch failures are reported once at the end, with the first reason (on a
// phone the console cannot be read).
const BATCH_MISMATCH = '응답의 줄 수·번호가 요청과 맞지 않아 버렸어요';
const shortReason = m => { const s = String(m || '알 수 없는 오류').replace(/\s+/g, ' ').trim(); return s.length > 120 ? s.slice(0, 120) + '…' : s; };

async function runTitleTranslation({ items, list, ns, pBar, pLabel, pWrap, btnStop, onDone, kind, targets: picked }) {
    if (isBusy) return;

    // Caller's pick, else the selection, else everything loaded.
    let scoped = picked;
    if (!scoped) {
        const selected = [...list.querySelectorAll('.pt-block-item.selected')].map(el => el.dataset.id);
        scoped = selected.length ? items.filter(b => selected.includes(b.id)) : items;
    }

    // Split into "needs translation" and "already has a translated title".
    // Names the panel supplies itself (ST's default slots, character card
    // fields) are never sent — not even on a redo.
    const named = scoped.filter(b => b.name && b.name.trim());
    const own = named.filter(b => builtinTitle(ns, b.id, b.name));
    const asked = named.filter(b => !builtinTitle(ns, b.id, b.name));
    const fresh = asked.filter(b => !getTranslatedTitle(ns, b.id, b.name));
    const already = asked.filter(b => getTranslatedTitle(ns, b.id, b.name));

    let targets = fresh;
    if (!fresh.length) {
        if (!already.length) {
            if (own.length) {
                if (typeof toastr !== 'undefined') toastr.info('기본 항목 이름은 번역 없이 바로 보여 드려요');
                if (typeof onDone === 'function') onDone();
                return;
            }
            if (typeof toastr !== 'undefined') toastr.info('번역할 제목이 없습니다');
            return;
        }
        // Everything already has a title — offer a redo rather than refusing.
        const redo = confirm(
            `제목 ${already.length}개가 이미 번역되어 있습니다.\n\n다시 번역할까요?\n\n[확인] = 재번역 (기존 제목 번역을 덮어씀)\n[취소] = 아무것도 하지 않음\n\n※ 본문 번역 데이터는 영향을 받지 않습니다.`
        );
        if (!redo) return;
        targets = already;
    }

    if (!targets.length) {
        if (typeof toastr !== 'undefined') toastr.info('번역할 제목이 없습니다');
        return;
    }

    isBusy = true; stopReq = false;
    const dot = PDOC.getElementById('pt-status-dot'), stTxt = PDOC.getElementById('pt-status-text');
    dot?.classList.add('busy');
    if (stTxt) stTxt.textContent = '제목 번역 중...';
    pWrap.classList.add('visible');
    if (btnStop) btnStop.disabled = false;

    const batches = [];
    const bs = titleBatchSize();
    for (let i = 0; i < targets.length; i += bs) {
        batches.push(targets.slice(i, i + bs));
    }

    let done = 0, okCount = 0, failCount = 0, firstErr = '';
    for (const batch of batches) {
        if (stopReq) break;
        try {
            const translated = await translateTitleBatch(batch.map(b => b.name), kind);
            if (translated) {
                batch.forEach((b, i) => { setCacheTitle(ns, b.id, translated[i]); });
                okCount += batch.length;
            } else {
                // Ambiguous reply — discard this batch instead of guessing.
                failCount += batch.length;
                if (!firstErr) firstErr = BATCH_MISMATCH;
                console.warn(`[${EXT}] title batch discarded (reply did not match ${batch.length} items)`);
            }
        } catch (err) {
            failCount += batch.length;
            if (!firstErr) firstErr = String(err?.message || err);
            console.warn(`[${EXT}] title batch failed`, err);
        }
        done += batch.length;
        const pct = Math.round(done / targets.length * 100);
        pBar.style.width = pct + '%';
        pLabel.textContent = `${done} / ${targets.length}  (${pct}%)`;
        if (!stopReq) await new Promise(r => setTimeout(r, requestDelayMs()));
    }

    try { updateCacheStatsUI(); } catch (e) {}
    isBusy = false;
    dot?.classList.remove('busy');
    pWrap.classList.remove('visible');
    if (btnStop) btnStop.disabled = true;
    if (stTxt) stTxt.textContent = stopReq ? '중단됨' : (failCount ? `제목 번역 끝 · 실패 ${failCount}개` : '제목 번역 완료 ✓');
    statusIdleSoon();

    if (typeof toastr !== 'undefined') {
        if (failCount) toastr.warning(`제목 ${okCount}개 번역 완료, ${failCount}개 실패 — ${shortReason(firstErr)}`);
        else toastr.success(`제목 ${okCount}개 번역 완료`);
    }
    if (typeof onDone === 'function') onDone();
}

// ══════════════════════════════════════════════════════════════════════
// Ask — question answering over the loaded preset / world info / card
// ══════════════════════════════════════════════════════════════════════
// Read-only by design: Ask only reads what the panel already loaded plus the
// regex / JS scripts bundled inside the same preset or card. It never changes
// anything in SillyTavern. Global and scoped regex are intentionally NOT read —
// they are not part of the material; the model is told to point to them as a
// possible cause instead.

const ASK_CONTROLLERS = {};          // kind → { open() }, registered by buildPage

// Ready-made questions shown as buttons in the Ask window (preset tab).
// [button label, question sent]. The last button asks about the toggles
// selected in the panel, so its question is built at click time.
const ASK_FAQ_PRESET = [
    ['분량',          '이 프리셋에서 답변의 분량을 조절하는 토글은 무엇인가요?'],
    ['언어',          '이 프리셋에서 출력 언어는 현재 어떻게 설정되어 있으며, 변경하려면 어떤 토글을 수정해야 하나요?'],
    ['시점',          '이 프리셋의 기본 서술 시점(1인칭, 3인칭 등)은 어떻게 설정되어 있으며, 어디서 수정하나요?'],
    ['NSFW',          '이 프리셋에서 NSFW 관련 설정은 어느 토글에 있나요?'],
    ['사칭',          '이 프리셋에 사칭 관련 옵션(AI가 유저의 대사와 행동까지 쓰게 하는지)이나 유저의 입력을 다시 쓰게 하는 옵션이 있나요? 있다면 어떤 토글인가요?'],
    ['진행 속도',     '이 프리셋에서 서사의 진행 속도(템포)를 조절할 수 있는 토글은 무엇인가요?'],
    ['상태창/선택지', '이 프리셋에 상태창이나 선택지를 출력하게 하는 토글이 있나요?'],
    ['필수 토글',     '이 프리셋에서 제작자가 꼭 켜라고 권장하는 토글은 어떤 것들인가요? AI 모델별로 다르다면 그것도 알려주세요.'],
];
const ASK_FAQ_SELECTED_MAX = 10;

// ── Ask answer archive ──
// Saved answers, one list per loaded item (preset / world info / character),
// stored in the meta IndexedDB — never in settings.json. Newest first.
// Clearing the translation cache does not touch it.
const ASK_ARCHIVE_PREFIX = 'askArchive::';
const ASK_ARCHIVE_MAX = 200;                 // per item
const askArchiveCache = new Map();           // key → entries[] (read once per session)
async function askArchiveLoad(key) {
    if (askArchiveCache.has(key)) return askArchiveCache.get(key);
    let list = [];
    try {
        const v = await metaGet(ASK_ARCHIVE_PREFIX + key);
        if (Array.isArray(v)) list = v.filter(e => e && typeof e.q === 'string' && typeof e.a === 'string');
    } catch (e) {
        // Not cached: the next open tries again, and no change is written over
        // a stored list that could not be read (see askArchiveUpdate)
        console.warn(`[${EXT}] answer archive read failed`, e);
        return null;
    }
    askArchiveCache.set(key, list);
    return list;
}
// Writes first, then updates the in-memory copy, so a failed write never
// shows as saved.
async function askArchiveWrite(key, list) {
    if (list.length) await metaPut(ASK_ARCHIVE_PREFIX + key, list);
    else await metaDelete(ASK_ARCHIVE_PREFIX + key);
    askArchiveCache.set(key, list);
}
// Changes to one archive run one after another, each on the list the previous
// one left (two quick saves would otherwise both start from the same list and
// the second would drop the first). fn(list) returns the new list, or null for
// no change. Resolves to fn's list (or null).
const askArchiveQueue = new Map();
function askArchiveUpdate(key, fn) {
    const run = (askArchiveQueue.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
        const list = await askArchiveLoad(key);
        if (!list) throw new Error('answer archive could not be read');
        const next = fn(list);
        if (next) await askArchiveWrite(key, next);
        return next;
    });
    askArchiveQueue.set(key, run);
    return run;
}
const askArchiveSig = (q, a) => `${q}\u0000${a}`;
// One-line plain text for card previews
const askPlain = (a) => String(a || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([#RSB]\d+)\]\]/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|`/g, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
const askBudget = () => Math.max(1000, cfg().askBudget || 60000);   // material ceiling, from settings

// ST regex placement enum → readable label for the model
const REGEX_PLACEMENT = { 1: 'user input', 2: 'AI output', 3: 'slash commands', 5: 'world info', 6: 'reasoning' };

// Collect regex and JS scripts bundled in an `extensions` object.
// Matches by shape instead of by key name, because JS-Slash-Runner has stored
// its scripts under different keys across versions.
function collectBundled(ext) {
    const regex = [], scripts = [];
    const seen = new WeakSet();
    const walk = (v, depth) => {
        if (!v || typeof v !== 'object' || depth > 8 || seen.has(v)) return;
        seen.add(v);
        if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
        // ST regex script
        if (typeof v.findRegex === 'string') {
            regex.push({
                name: String(v.scriptName || '(이름 없음)'),
                find: v.findRegex,
                replace: typeof v.replaceString === 'string' ? v.replaceString : '',
                enabled: v.disabled !== true,
                placement: Array.isArray(v.placement) ? v.placement : [],
                displayOnly: !!v.markdownOnly,
                promptOnly: !!v.promptOnly,
                raw: v,              // read-only reference, for the preset compare
            });
            return;
        }
        // JS-Slash-Runner script: has a name and code, plus a script marker
        const looksLikeScript = typeof v.name === 'string' && typeof v.content === 'string'
            && ('type' in v ? v.type === 'script' : ('id' in v || 'info' in v));
        if (looksLikeScript) {
            scripts.push({ name: v.name, code: v.content, enabled: v.enabled !== false, raw: v });
            return;
        }
        for (const k of Object.keys(v)) walk(v[k], depth + 1);
    };
    walk(ext, 0);
    return { regex, scripts };
}

// The object the loaded items came from, read-only.
function getAskSource(kind, selVal) {
    try {
        if (kind === 'preset') {
            const cur = getCurrentPresetName();
            const name = selVal || cur || '';
            const idx = openai_setting_names?.[name];
            const saved = idx !== undefined ? openai_settings[idx] : null;
            // Live state first (unsaved edits), saved copy as fallback — the live
            // object does not always carry `extensions`.
            const live = (name === cur && oai_settings?.extensions && Object.keys(oai_settings.extensions).length)
                ? oai_settings.extensions : null;
            return { label: `프리셋 "${name}"`, extensions: live || saved?.extensions || null, book: null };
        }
        if (kind === 'char') {
            const idx = findCharIndex(selVal);
            const ch = idx >= 0 ? characters[idx] : null;
            const book = ch?.data?.character_book?.entries;
            return {
                label: `캐릭터카드 "${ch?.name || selVal || ''}"`,
                extensions: ch?.data?.extensions || null,
                book: Array.isArray(book) ? book : null,
            };
        }
        return { label: `월드인포 "${selVal || ''}"`, extensions: null, book: null };
    } catch (e) {
        return { label: '', extensions: null, book: null };
    }
}

const cutText = (t, max) => {
    const s = String(t || '');
    if (!isFinite(max) || s.length <= max) return s;
    return s.slice(0, max) + `\n…[truncated: ${(s.length - max).toLocaleString()} more characters]`;
};

// Build the MATERIAL block. Tries progressively shorter versions until the
// estimate fits the budget. Item tags use the item's position in the full
// loaded list, so a tag always points at the same row in the panel.
function buildAskMaterial({ kind, items, scopeIds, regexMode = 'names', includeScripts = true, bundles, book, includeBook = true, bookEnabledOnly = true, sourceLabel }) {
    const all = items.map((b, i) => [b, i]);
    const picked = (scopeIds && scopeIds.size) ? all.filter(([b]) => scopeIds.has(String(b.id))) : all;
    const levels = [
        { item: Infinity, off: Infinity, code: Infinity },
        { item: Infinity, off: Infinity, code: 3000 },
        { item: Infinity, off: 300,      code: 1500 },
        { item: 1500,     off: 200,      code: 800  },
        { item: 600,      off: 120,      code: 400  },
    ];
    const compose = (L) => {
        const refs = new Map();
        const out = [`=== MATERIAL: ${sourceLabel} ===`];
        if (picked.length < all.length) out.push(`(Only ${picked.length} of ${all.length} items were selected by the user and are included.)`);
        for (const [b, i] of picked) {
            const tag = `#${i + 1}`;
            refs.set(tag, { type: 'item', id: String(b.id), name: b.name || String(b.id) });
            const off = b.enabled === false;
            const state = b.isChar ? '' : (off ? '[OFF] ' : '[ON] ');
            let meta = '';
            if (b.meta) {
                const m = b.meta, bits = [m.strategy === 'const' ? 'constant' : (m.strategy === 'vector' ? 'vectorized' : 'keyed')];
                if (m.position) bits.push(`position ${m.position}`);
                if (m.depth != null) bits.push(`depth ${m.depth}`);
                if (m.order != null) bits.push(`order ${m.order}`);
                if (m.probability != null && m.probability !== 100) bits.push(`trigger ${m.probability}%`);
                meta = `\n(${bits.join(', ')})`;
            }
            out.push(`[[${tag}]] ${state}${b.name || b.id}${meta}\n<<<\n${cutText(b.content, off ? L.off : L.item)}\n>>>`);
        }
        if (includeBook && Array.isArray(book) && book.length) {
            const rows = book.map((e, k) => [e, k]).filter(([e]) => !bookEnabledOnly || e?.enabled !== false);
            if (rows.length) out.push(`=== EMBEDDED LOREBOOK (inside the card)${bookEnabledOnly && rows.length < book.length ? ` — enabled entries only (${rows.length} of ${book.length})` : ''} ===`);
            rows.forEach(([e, k]) => {
                const tag = `B${k + 1}`;   // numbered by position in the full book, so tags never shift
                const name = e?.comment || e?.name || `Entry ${k + 1}`;
                refs.set(tag, { type: 'book', name });
                const keys = Array.isArray(e?.keys) ? e.keys.join(', ') : '';
                out.push(`[[${tag}]] ${e?.enabled === false ? '[OFF] ' : ''}${name}${keys ? `\nkeys: ${keys}` : ''}\n<<<\n${cutText(e?.content, L.item)}\n>>>`);
            });
        }
        if (bundles) {
            if (regexMode !== 'off' && bundles.regex.length) {
                out.push(regexMode === 'names'
                    ? '=== REGEX SCRIPTS (bundled) — names only; patterns are not included. If the answer depends on what a regex actually matches or outputs, name the regex to check. ==='
                    : '=== REGEX SCRIPTS (bundled) ===');
                bundles.regex.forEach((r, k) => {
                    const tag = `R${k + 1}`;
                    refs.set(tag, { type: 'regex', name: r.name });
                    const where = r.placement.map(p => REGEX_PLACEMENT[p] || `placement ${p}`).join(', ') || 'unspecified';
                    const flags = [r.enabled ? 'enabled' : 'disabled', r.displayOnly ? 'display only' : '', r.promptOnly ? 'prompt only' : ''].filter(Boolean).join(', ');
                    out.push(regexMode === 'names'
                        ? `[[${tag}]] ${r.name} (${flags}; applies to: ${where})`
                        : `[[${tag}]] ${r.name} (${flags}; applies to: ${where})\nfind: ${cutText(r.find, L.code)}\nreplace:\n<<<\n${cutText(r.replace, L.code)}\n>>>`);
                });
            }
            if (includeScripts && bundles.scripts.length) {
                out.push('=== JS SCRIPTS (bundled, JS-Slash-Runner) ===');
                bundles.scripts.forEach((sc, k) => {
                    const tag = `S${k + 1}`;
                    refs.set(tag, { type: 'script', name: sc.name });
                    out.push(`[[${tag}]] ${sc.name} (${sc.enabled ? 'enabled' : 'disabled'})\n<<<\n${cutText(sc.code, L.code)}\n>>>`);
                });
            }
        }
        return { text: out.join('\n\n'), refs };
    };
    for (let i = 0; i < levels.length; i++) {
        const r = compose(levels[i]);
        const est = estimateTokens(r.text);
        if (est <= askBudget() || i === levels.length - 1) {
            return { ...r, est, trimmed: i > 0, overBudget: est > askBudget() };
        }
    }
}

function askInstructions(kind, lang) {
    const what = kind === 'preset' ? 'a SillyTavern prompt preset'
               : kind === 'wi'     ? 'a SillyTavern world info (lorebook) book'
               :                     'a SillyTavern character card';
    return `You are the help assistant inside "Prompt Panel", a SillyTavern extension. The user has loaded ${what} and is asking about it. Base your answer ONLY on the MATERIAL below.

How to answer:
- Answer in ${lang}. Be concise and practical. Prefer short paragraphs or a short list.
- Cite every item you rely on with its tag exactly as written: [[#12]] for a numbered item, [[R3]] for a regex script, [[S2]] for a JS script, [[B4]] for an embedded lorebook entry. Only use tags that appear in the MATERIAL.
- When the user wants to change a behaviour, name the item to edit and what to change in it. The user makes the edit in SillyTavern; you cannot change anything.
- Items marked [OFF] are disabled and currently have no effect.
- If the MATERIAL does not explain something, say so plainly instead of guessing. Behaviour can also come from outside this material — global or character-scoped regex, other extensions, SillyTavern's formatting settings, or the model itself. Mention this when it is a likely cause.
- Scripts that import code from external URLs only show the import line; that code is not visible here. Say so when it matters.
- Text marked [truncated] was shortened to fit; say so if the answer may depend on the missing part.`;
}

// Chat completion call for Ask. Same connection settings as translation,
// but never uses the translation prefill (it would derail an answer).
async function askChatCompletion(messages, signal) {
    const c = cfg();
    // 0 / empty mean "leave it to the model / the translation setting"
    const { text, cut } = await callModel(messages, { maxTokens: c.askMaxTokens, temperature: c.askTemperature, signal });
    if (!text) {
        throw new Error(cut
            ? '답변 길이 제한에 걸려 빈 응답이 왔습니다. 설정에서 최대 답변 길이를 늘리거나 0으로 두세요'
            : '빈 응답을 받았습니다');
    }
    return cut ? text + '\n\n…(답변 길이 제한으로 잘렸습니다)' : text;
}

// Turn a model answer into safe HTML. Everything is escaped first; only a
// small set of formatting and the [[tag]] references are turned back into markup.
function renderAskAnswer(raw, refs) {
    // Escape first; only the markup produced below ever becomes HTML.
    const pres = [], codes = [];
    let h = esc(raw).replace(/```[\w-]*\n?([\s\S]*?)```/g, (m, code) => {
        pres.push(`<pre class="pt-ask-pre">${code.replace(/\n$/, '')}</pre>`);
        return `\u0000${pres.length - 1}\u0000`;
    });
    h = h.replace(/`\s*(\[\[[#RSB]\d+\]\])\s*`/g, '$1')   // `[[#3]]` → just the chip
         // Inline code is set aside too, so emphasis marks inside it stay literal
         .replace(/`([^`\n]+)`/g, (m, c) => { codes.push(`<code>${c}</code>`); return `\u0001${codes.length - 1}\u0001`; })
         // Emphasis. Markers must hug the text (no space just inside), and single
         // * or _ must not touch a letter/digit outside — so "2 * 3", "*.json",
         // snake_case and "a*b*c" stay as they are.
         // No lookbehind here: Safari before 16.4 rejects it, and a regex literal
         // it cannot parse stops this whole file from loading.
         .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
         .replace(/(^|[^\w])__([^_\s](?:[^_\n]*?[^_\s])?)__(?!\w)/g, '$1<b>$2</b>')
         .replace(/~~([^~\s](?:[^~\n]*?[^~\s])?)~~/g, '<s>$1</s>')
         .replace(/(^|[^*\w])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![*\w])/g, '$1<i>$2</i>')
         .replace(/(^|[^\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\w])/g, '$1<i>$2</i>')
         .replace(/\[\[([#RSB]\d+)\]\]/g, (m, tag) => {
             const r = refs && refs.get(tag);
             if (!r) return `<span class="pt-ask-ref bad" title="자료에 없는 항목">${esc(tag)} 확인 안 됨</span>`;
             if (r.type === 'item') return `<button type="button" class="pt-ask-ref" data-ref="${esc(tag)}" data-id="${esc(r.id)}" title="패널에서 보기">${esc(tag)} ${esc(r.name)}</button>`;
             const kindLabel = r.type === 'regex' ? '정규식' : (r.type === 'script' ? '스크립트' : '임베디드 월드북');
             return `<span class="pt-ask-ref static">${kindLabel} · ${esc(r.name)}</span>`;
         });
    // Line-level markdown. Headings (# … ######) become a bold line, "---" a
    // divider, "> " a quote, "- " / "* " bullets a dot. Code blocks were swapped
    // out above, so a "#" inside code is never touched. "#3" (no space) is not a heading.
    const lines = h.split('\n').map(line => {
        const hd = line.match(/^\s{0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
        if (hd) return { html: `<span class="pt-ask-h pt-ask-h${Math.min(hd[1].length, 3)}">${hd[2]}</span>`, block: true };
        if (/^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) return { html: '<span class="pt-ask-hr"></span>', block: true };
        if (/^\u0000\d+\u0000$/.test(line)) return { html: line, block: true };
        const qt = line.match(/^\s{0,3}&gt;[ \t]?(.*)$/);
        if (qt) return { html: `<span class="pt-ask-quote">${qt[1] || '&nbsp;'}</span>`, block: true };
        const li = line.match(/^(\s*)[-*][ \t]+(.*)$/);
        if (li) return { html: `${'&nbsp;'.repeat(Math.min(li[1].length, 8))}• ${li[2]}`, block: false };
        return { html: line, block: false };
    });
    h = lines.map((l, i) => l.html + (i < lines.length - 1 && !l.block ? '<br>' : '')).join('');
    return h.replace(/\u0001(\d+)\u0001/g, (m, i) => codes[+i]).replace(/\u0000(\d+)\u0000/g, (m, i) => pres[+i]);
}


// Ask styles. Injected once; every rule is scoped under #pt-panel and uses the
// theme variables, so it follows whichever stylesheet/theme is active.
function ensureAskCss() {
    if (PDOC.getElementById('pt-ask-css')) return;
    const st = PDOC.createElement('style');
    st.id = 'pt-ask-css';
    st.textContent = `
#pt-panel .pt-ask-backdrop{position:absolute;inset:0;z-index:10002;display:flex;align-items:stretch;justify-content:center;padding:8px;box-sizing:border-box;background:var(--pt-overlay,rgba(0,0,0,.5))}
#pt-panel .pt-ask-box{width:100%;max-width:560px;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-radius:12px;border:1px solid var(--pt-border-strong,#555);background:var(--pt-bg,#1a1a2e);color:var(--pt-text,#e0e0e0);box-shadow:0 10px 40px rgba(0,0,0,.3)}
#pt-panel .pt-ask-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--pt-border,#333)}
#pt-panel .pt-ask-title{flex:1;min-width:0;font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pt-panel .pt-ask-close{background:none;border:none;color:var(--pt-text-dim,#999);font-size:16px;cursor:pointer;padding:2px 6px}
#pt-panel .pt-ask-opts{display:flex;flex-wrap:wrap;gap:4px 12px;padding:8px 12px;font-size:11px;color:var(--pt-text-dim,#999);border-bottom:1px solid var(--pt-border,#333)}
#pt-panel .pt-ask-opts label{display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}
#pt-panel .pt-ask-opts .pt-ask-dis{opacity:.45;cursor:default}
#pt-panel .pt-ask-log{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
#pt-panel .pt-ask-empty{margin:auto;text-align:center;font-size:11px;line-height:1.8;color:var(--pt-text-dim,#999)}
#pt-panel .pt-ask-msg{font-size:var(--pt-translated-size,12px);line-height:1.65;padding:8px 10px;border-radius:10px;overflow-wrap:anywhere}
#pt-panel .pt-ask-msg.q{align-self:flex-end;max-width:85%;background:var(--pt-accent-soft,rgba(120,140,255,.15))}
#pt-panel .pt-ask-msg.a{background:var(--pt-content-bg,rgba(255,255,255,.05));border:1px solid var(--pt-border,#333)}
#pt-panel .pt-ask-msg.wait{color:var(--pt-text-dim,#999);font-style:italic}
#pt-panel .pt-ask-msg.err{color:#ef4444;border:1px solid rgba(239,68,68,.35)}
#pt-panel .pt-ask-msg code,#pt-panel .pt-ask-card-ans code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;padding:0 4px;border-radius:4px;color:var(--pt-accent-strong,var(--pt-text,#e0e0e0));background:var(--pt-accent-soft,rgba(127,127,127,.15));border:1px solid var(--pt-border,rgba(127,127,127,.3));opacity:1}
#pt-panel .pt-ask-pre{margin:4px 0;padding:6px 8px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--pt-text,#e0e0e0);background:var(--pt-content-bg,rgba(127,127,127,.12));border:1px solid var(--pt-border,rgba(127,127,127,.3))}
#pt-panel .pt-ask-msg b{color:var(--pt-text,inherit)}
#pt-panel .pt-ask-h{display:block;margin:6px 0 2px;font-weight:700;color:var(--pt-text,inherit)}
#pt-panel .pt-ask-h1{font-size:1.17em}
#pt-panel .pt-ask-h2{font-size:1.08em}
#pt-panel .pt-ask-h3{font-size:1.04em}
#pt-panel .pt-ask-quote{display:block;margin:3px 0;padding:2px 0 2px 9px;border-left:3px solid var(--pt-border-strong,#888);color:var(--pt-text-dim,inherit)}
#pt-panel .pt-ask-quote+.pt-ask-quote{margin-top:-3px}
#pt-panel .pt-ask-hr{display:block;height:0;margin:8px 0;border-top:1px solid var(--pt-border,rgba(127,127,127,.3))}
#pt-panel .pt-ask-regen{align-self:flex-end;margin-top:-4px;width:26px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;border:1px solid var(--pt-border,#8884);background:transparent;color:var(--pt-text-dim,#999);font-size:12px;cursor:pointer}
#pt-panel .pt-ask-opts select{font-size:11px;height:24px;padding:0 4px;border-radius:6px;border:1px solid var(--pt-border-strong,#555);background:var(--pt-select-bg,#222);color:var(--pt-select-text,#eee)}
#pt-panel .pt-ask-ref{display:inline-block;max-width:100%;margin:1px 2px;padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.5;vertical-align:baseline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--pt-accent,#7ba3cc);color:var(--pt-accent,#7ba3cc);background:transparent;cursor:pointer}
#pt-panel .pt-ask-ref.static{cursor:default;border-style:dashed}
#pt-panel .pt-ask-ref.bad{cursor:default;border-color:#ef4444;color:#ef4444}
#pt-panel .pt-ask-foot{display:flex;flex-direction:column;gap:6px;padding:8px 12px 10px;border-top:1px solid var(--pt-border,#333)}
#pt-panel .pt-ask-est{font-size:10px;line-height:1.5;color:var(--pt-text-dim,#999)}
#pt-panel .pt-ask-acts{display:flex;justify-content:flex-end;gap:6px;margin-top:-4px}
#pt-panel .pt-ask-acts .pt-ask-regen{margin-top:0;align-self:auto}
#pt-panel .pt-ask-save{width:26px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;border:1px solid var(--pt-border,#8884);background:transparent;color:var(--pt-text-dim,#999);font-size:12px;cursor:pointer}
#pt-panel .pt-ask-save.on{color:var(--pt-accent-strong,#5b7bd5);border-color:var(--pt-accent-strong,#5b7bd5)}
#pt-panel .pt-ask-arch-btn{margin-left:auto;padding:2px 9px;border-radius:999px;font-size:11px;white-space:nowrap;cursor:pointer;border:1px solid var(--pt-border-strong,#888);background:transparent;color:var(--pt-text-dim,#888)}
#pt-panel .pt-ask-arch-btn.on{color:var(--pt-accent-strong,#5b7bd5);border-color:var(--pt-accent-strong,#5b7bd5);background:var(--pt-accent-soft,rgba(91,123,213,.12))}
#pt-panel .pt-ask-arch{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
#pt-panel .pt-ask-arch[hidden],#pt-panel .pt-ask-log[hidden],#pt-panel .pt-ask-foot[hidden],#pt-panel .pt-ask-card-body[hidden]{display:none!important}
#pt-panel .pt-ask-arch-bar{display:flex;align-items:center;gap:8px;font-size:12px}
#pt-panel .pt-ask-arch-title{flex:1;font-weight:700;color:var(--pt-text,inherit)}
#pt-panel .pt-ask-arch-bar button{padding:3px 10px;border-radius:8px;font-size:11px;cursor:pointer;border:1px solid var(--pt-border-strong,#888);background:transparent;color:var(--pt-text-dim,#888)}
#pt-panel .pt-ask-arch-bar button:disabled{opacity:.45;cursor:default}
#pt-panel .pt-ask-card{border:1px solid var(--pt-border,#8884);border-radius:10px;background:var(--pt-content-bg,rgba(255,255,255,.04))}
#pt-panel .pt-ask-card.open{border-color:var(--pt-border-strong,#888)}
#pt-panel .pt-ask-card-head{padding:8px 10px;cursor:pointer}
#pt-panel .pt-ask-card-q{font-size:12px;font-weight:700;line-height:1.5;color:var(--pt-text,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pt-panel .pt-ask-card-tag{display:inline-block;padding:0 8px;border-radius:999px;font-size:11px;border:1px solid var(--pt-accent-strong,#5b7bd5);color:var(--pt-accent-strong,#5b7bd5)}
#pt-panel .pt-ask-card-prev{margin-top:3px;font-size:11px;line-height:1.55;color:var(--pt-text-dim,#888);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
#pt-panel .pt-ask-card.open .pt-ask-card-prev{display:none}
#pt-panel .pt-ask-card-body{padding:0 10px 8px}
#pt-panel .pt-ask-card-full-q{font-size:11px;line-height:1.5;color:var(--pt-text-dim,#888);margin-bottom:6px;overflow-wrap:anywhere}
#pt-panel .pt-ask-card-ans{max-height:55vh;overflow-y:auto;-webkit-overflow-scrolling:touch;font-size:var(--pt-translated-size,12px);line-height:1.65;padding:8px 10px;border-radius:8px;border:1px solid var(--pt-border,#8884);background:var(--pt-bg,transparent);overflow-wrap:anywhere}
#pt-panel .pt-ask-card-foot{display:flex;align-items:center;justify-content:space-between;margin-top:6px;font-size:10px;color:var(--pt-text-dim,#888)}
#pt-panel .pt-ask-card-del{width:26px;height:24px;padding:0;border-radius:7px;cursor:pointer;border:1px solid var(--pt-border,#8884);background:transparent;color:var(--pt-text-dim,#888);font-size:11px}
#pt-panel .pt-ask-faq{display:flex;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding-bottom:1px}
#pt-panel .pt-ask-faq::-webkit-scrollbar{display:none}
#pt-panel .pt-ask-faq button{flex:0 0 auto;padding:3px 10px;border-radius:999px;font-size:11px;line-height:1.5;white-space:nowrap;cursor:pointer;border:1px solid var(--pt-border-strong,#888);background:transparent;color:var(--pt-text-dim,#888)}
#pt-panel .pt-ask-faq button:disabled{opacity:.45;cursor:default}
#pt-panel .pt-ask-input{width:100%;min-height:52px;box-sizing:border-box;resize:vertical;padding:6px 8px;border-radius:8px;font-size:12px;font-family:inherit;border:1px solid var(--pt-border-strong,#555);background:var(--pt-select-bg,#222);color:var(--pt-select-text,#eee)}
#pt-panel .pt-ask-actions{display:flex;gap:6px}
#pt-panel .pt-ask-actions button{flex:1;height:32px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
#pt-panel .pt-ask-reset{background:transparent;border:1px solid var(--pt-border-strong,#555);color:var(--pt-text-dim,#999)}
#pt-panel .pt-ask-send{border:none;background:var(--pt-btn-primary-bg,#7ba3cc);color:var(--pt-btn-primary-text,#fff)}
#pt-panel .pt-block-item.pt-ask-flash{outline:2px solid var(--pt-accent,#7ba3cc);outline-offset:2px}
`;
    PDOC.head.appendChild(st);
}

// ── Preset compare (2-way, read-only) ─────────────────────────────────
// Compares two presets toggle by toggle. Everything here only READS ST's
// preset objects; strings are copied into a snapshot at compare time, and the
// snapshot lives in memory until the next compare. Text diffs are computed
// lazily, only when a row is expanded.

// Myers diff over two arrays (items compared with ===).
// Returns [[op, ai, bi], ...] with op '=', '-' or '+', or null when the edit
// distance exceeds maxD. The trace costs about D² integers, so maxD bounds both
// time and memory; callers show a coarse view instead of a null result.
function diffSeq(a, b, maxD) {
    const n = a.length, m = b.length;
    let pre = 0;
    while (pre < n && pre < m && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
    const mid = diffCore(a, b, pre, n - suf, pre, m - suf, maxD);
    if (!mid) return null;
    const ops = [];
    for (let i = 0; i < pre; i++) ops.push(['=', i, i]);
    for (const o of mid) ops.push(o);
    for (let k = suf; k > 0; k--) ops.push(['=', n - k, m - k]);
    return ops;
}
function diffCore(a, b, a0, a1, b0, b1, maxD) {
    const n = a1 - a0, m = b1 - b0, out = [];
    if (!n) { for (let j = b0; j < b1; j++) out.push(['+', -1, j]); return out; }
    if (!m) { for (let i = a0; i < a1; i++) out.push(['-', i, -1]); return out; }
    const max = Math.min(n + m, maxD);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let D = -1;
    search:
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice(off - d - 1, off + d + 2));      // k ∈ [-d-1, d+1]
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++; }
            v[off + k] = x;
            if (x >= n && y >= m) { D = d; break search; }
        }
    }
    if (D < 0) return null;
    let x = n, y = m;
    for (let d = D; d >= 0; d--) {
        const w = trace[d];
        const at = kk => w[kk + d + 1];
        const k = x - y;
        const pk = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
        const px = at(pk), py = px - pk;
        while (x > px && y > py) { x--; y--; out.push(['=', a0 + x, b0 + y]); }
        if (d > 0) {
            if (x === px) { y--; out.push(['+', -1, b0 + y]); }
            else          { x--; out.push(['-', a0 + x, -1]); }
        }
        x = px; y = py;
    }
    return out.reverse();
}

// Lines → small integers, so the line diff compares numbers, not strings.
function internLines(A, B) {
    const map = new Map();
    const id = s => { let k = map.get(s); if (k === undefined) { k = map.size; map.set(s, k); } return k; };
    return [A.map(id), B.map(id)];
}

// Inline tokens: one token per Han/Kana character (no spaces between words
// there), whole words elsewhere (Hangul, Latin…), whitespace runs, and single
// punctuation/symbol characters.
const DIFF_TOKEN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{P}\p{S}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|\s+|[^]/gu;
const diffTokens = s => s.match(DIFF_TOKEN_RE) || [];

// One changed line pair → HTML with <del>/<ins> inside, or null when the two
// lines share too little to be worth showing inline.
function diffInlinePair(la, lb) {
    const ta = diffTokens(la), tb = diffTokens(lb);
    const ops = diffSeq(ta, tb, 600);
    if (!ops) return null;
    let same = 0;
    for (const o of ops) if (o[0] === '=') same += ta[o[1]].length;
    if (same / (Math.max(la.length, lb.length) || 1) < 0.35) return null;
    // Within each changed stretch show all deletions first, then insertions.
    let html = '', eq = '', del = '', ins = '';
    const flushChange = () => {
        if (del) html += `<del>${esc(del)}</del>`;
        if (ins) html += `<ins>${esc(ins)}</ins>`;
        del = ins = '';
    };
    for (const [t, i, j] of ops) {
        if (t === '=') { if (del || ins) flushChange(); eq += ta[i]; continue; }
        if (eq) { html += esc(eq); eq = ''; }
        if (t === '-') del += ta[i]; else ins += tb[j];
    }
    if (eq) html += esc(eq);
    flushChange();
    return html;
}

const DIFF_CTX = 2;   // unchanged lines kept around each change
function renderTextDiff(oldText, newText) {
    const A = String(oldText ?? '').split(/\r?\n/), B = String(newText ?? '').split(/\r?\n/);
    const [ia, ib] = internLines(A, B);
    const ops = diffSeq(ia, ib, 1000);
    if (!ops) return `<div class="pt-df-note" style="padding:6px 8px;margin:0">차이가 너무 커서 줄 단위 비교를 생략했습니다. 아래 복사 버튼으로 두 원문을 받아 직접 비교해 주세요.</div>`;

    const rows = [];   // [type, html]  type: '=', '-', '+', '~'
    let dels = [], inss = [];
    const flush = () => {
        const n = Math.min(dels.length, inss.length);
        for (let k = 0; k < n; k++) {
            const h = diffInlinePair(A[dels[k]], B[inss[k]]);
            if (h != null) rows.push(['~', h]);
            else { rows.push(['-', esc(A[dels[k]])]); rows.push(['+', esc(B[inss[k]])]); }
        }
        for (let k = n; k < dels.length; k++) rows.push(['-', esc(A[dels[k]])]);
        for (let k = n; k < inss.length; k++) rows.push(['+', esc(B[inss[k]])]);
        dels = []; inss = [];
    };
    for (const [t, i, j] of ops) {
        if (t === '=') { flush(); rows.push(['=', esc(A[i])]); }
        else if (t === '-') dels.push(i);
        else inss.push(j);
    }
    flush();

    const CLS = { '=': '', '-': 'del', '+': 'ins', '~': 'mod' };
    const MARK = { '=': '', '-': '−', '+': '+', '~': '±' };
    const line = ([t, h]) => `<div class="pt-df-l ${CLS[t]}"><span class="pt-df-g">${MARK[t]}</span><span class="pt-df-t">${h || '&nbsp;'}</span></div>`;
    let out = '';
    for (let s = 0; s < rows.length;) {
        if (rows[s][0] !== '=') { out += line(rows[s]); s++; continue; }
        let e = s; while (e < rows.length && rows[e][0] === '=') e++;
        const head = s === 0 ? 0 : DIFF_CTX, tail = e === rows.length ? 0 : DIFF_CTX;
        const len = e - s;
        if (len - head - tail >= 2) {
            for (let k = s; k < s + head; k++) out += line(rows[k]);
            const hid = rows.slice(s + head, e - tail);
            out += `<button type="button" class="pt-df-more" data-act="unfold">⋯ 같은 줄 ${hid.length}개 ⋯</button><div class="pt-df-hid" hidden>${hid.map(line).join('')}</div>`;
            for (let k = e - tail; k < e; k++) out += line(rows[k]);
        } else {
            for (let k = s; k < e; k++) out += line(rows[k]);
        }
        s = e;
    }
    return out;
}

// One preset's toggles as the panel sees them: the currently selected preset
// is read from ST's live working state (same rule as the preset tab), any
// other from its saved copy. Read-only.
function readPresetToggles(name) {
    if (!name) return null;
    const cur = getCurrentPresetName();
    const idx = openai_setting_names?.[name];
    const saved = idx !== undefined ? openai_settings?.[idx] : null;
    const isLive = name === cur && !!oai_settings;
    const src = isLive ? oai_settings : saved;
    if (!src) return null;
    return { isLive, src, saved, items: presetItemsOf(src) };
}

// Toggles of a preset object in prompt order. fromPrompts: when the preset has
// no order (a hand-made file), fall back to the order of the prompts array.
function presetItemsOf(src, fromPrompts = false) {
    const prompts = Array.isArray(src.prompts) ? src.prompts : [];
    const orders = Array.isArray(src.prompt_order) ? src.prompt_order : [];
    const charOrder = orders.find(o => String(o?.character_id) === '100001')
        || orders.find(o => String(o?.character_id) === '100000') || orders[0];
    const map = new Map();
    for (const p of prompts) {
        if (p && p.identifier != null && !map.has(String(p.identifier))) map.set(String(p.identifier), p);
    }
    const items = [], seen = new Set();
    let order = Array.isArray(charOrder?.order) ? charOrder.order : [];
    if (!order.length && fromPrompts) order = prompts.filter(p => p && p.identifier != null).map(p => ({ identifier: p.identifier, enabled: true }));
    for (const e of order) {
        const id = String(e?.identifier ?? '');
        const p = map.get(id);
        if (!p || seen.has(id)) continue;
        seen.add(id);
        items.push({
            id,
            name: String(p.name || id),
            enabled: e.enabled !== false,
            content: typeof p.content === 'string' ? p.content : '',
            role: p.role || 'system',
            pos: Number(p.injection_position) === 1 ? 1 : 0,
            depth: p.injection_depth ?? null,
            iorder: p.injection_order ?? null,
            // When ST sends it (generation types; empty = always) and whether a
            // character's own prompt may replace it — both change behaviour
            trigger: Array.isArray(p.injection_trigger) ? p.injection_trigger.map(String).sort() : [],
            forbid: p.forbid_overrides === true,
            idx: items.length,
        });
    }
    return items;
}

function readPresetForDiff(name) {
    const T = readPresetToggles(name);
    if (!T) return null;
    const { isLive, src, saved, items } = T;
    const ext = (isLive && src.extensions && Object.keys(src.extensions).length) ? src.extensions : (saved?.extensions || null);
    // Preset values always come from the saved copy: ST's live state names the
    // same values differently (temp_openai vs temperature …), so mixing the two
    // would compare mismatched keys.
    return { name, isLive, items, settings: saved || null, bundles: collectBundled(ext) };
}

// ── Reuse translations of identical toggles ──────────────────────────
// A custom copy of a preset saved under another name has no translations of
// its own, though most of its toggles are unchanged. For each toggle that is
// missing a translation (in the current language), this looks through the
// other installed presets:
//   full  — same name and same text  → copy the whole translation
//   title — same name only           → copy just the translated title
// Nothing is copied until the user taps, and existing translations are never
// replaced.
// Translations older versions stored under "no selection" (__cur__) belong to
// whichever preset was current then, which cannot be known. They are offered
// separately (legacy: true), only for the preset that is current now, and
// only with a note saying so — never applied on their own.
const CUR_NS = 'pt-preset::__cur__';
function findReusableTranslations(targetNs, targetName, items) {
    if (!translationMap.size) return { picks: [], sources: [] };
    const needFull  = b => !getCached(targetNs, b.id);
    // Default ST slots (Chat History …) are in every preset; their titles are
    // never offered as "found in another preset".
    const needTitle = b => !isDefaultSlotName(b.id, b.name) && !getTranslatedTitle(targetNs, b.id, b.name);
    if (!items.some(b => needFull(b) || needTitle(b))) return { picks: [], sources: [] };
    const full = new Map(), title = new Map();   // key → { text, from }
    for (const { name } of listAllPresets()) {
        if (!name || name === targetName) continue;
        const ns = `pt-preset::${name}`;
        const T = readPresetToggles(name);
        if (!T) continue;
        for (const it of T.items) {
            // Look the translation up first: most toggles have none, and the
            // name + text key is only built for those that do
            const tr = it.content.trim() ? getCached(ns, it.id) : null;
            if (tr) {
                const fk = `${it.name}\u0000${it.content}`;
                if (!full.has(fk)) full.set(fk, { text: tr, from: name });
            }
            if (!title.has(it.name)) {
                const tt = getTranslatedTitle(ns, it.id);
                if (tt) title.set(it.name, { text: tt, from: name });
            }
        }
    }
    const picks = [];
    const legacyOk = !!targetName && targetNs !== CUR_NS && targetName === getCurrentPresetName();
    for (const b of items) {
        const f = needFull(b) && b.content.trim() ? full.get(`${b.name}\u0000${b.content}`) : null;
        if (f) { picks.push({ id: b.id, kind: 'full', text: f.text, from: f.from }); continue; }
        const t = needTitle(b) ? title.get(b.name) : null;
        if (t) { picks.push({ id: b.id, kind: 'title', text: t.text, from: t.from }); continue; }
        if (!legacyOk) continue;
        const lf = needFull(b) && b.content.trim() ? getCached(CUR_NS, b.id) : null;
        if (lf) { picks.push({ id: b.id, kind: 'full', text: lf, legacy: true }); continue; }
        const lt = needTitle(b) ? getTranslatedTitle(CUR_NS, b.id) : null;
        if (lt) picks.push({ id: b.id, kind: 'title', text: lt, legacy: true });
    }
    return { picks, sources: [...new Set(picks.filter(p => !p.legacy).map(p => p.from))] };
}

// ST's generation types (PromptManager's trigger list)
const TRIGGER_LABEL = { normal: '일반', continue: '이어쓰기', impersonate: '사칭', swipe: '스와이프', regenerate: '다시 생성', quiet: '조용한 생성' };
function diffPromptConf(a, b) {
    const out = [];
    const posL = p => p === 1 ? '채팅 내(@D)' : '상대';
    const trigL = t => t.length ? t.map(x => TRIGGER_LABEL[x] || x).join(', ') : '모든 생성';
    if (a.role !== b.role) out.push(['역할', a.role, b.role]);
    if (a.pos !== b.pos) out.push(['삽입 위치', posL(a.pos), posL(b.pos)]);
    if (a.pos === 1 || b.pos === 1) {
        if (String(a.depth ?? '') !== String(b.depth ?? '')) out.push(['깊이', a.depth ?? '-', b.depth ?? '-']);
        if (String(a.iorder ?? '') !== String(b.iorder ?? '')) out.push(['순서값', a.iorder ?? '-', b.iorder ?? '-']);
    }
    if ((a.trigger || []).join() !== (b.trigger || []).join()) out.push(['실행 조건', trigL(a.trigger || []), trigL(b.trigger || [])]);
    if (!!a.forbid !== !!b.forbid) out.push(['덮어쓰기 금지', a.forbid ? '켜짐' : '꺼짐', b.forbid ? '켜짐' : '꺼짐']);
    return out;
}

// Pair toggles, classify each pair, and lay the result out in B's order with
// A-only toggles placed after their nearest preceding A neighbour.
// Pairing order:
//   1. ST's built-in slots by identifier (fixed ids)
//   2. a name that appears exactly once on each side
//   3. identifier (catches renames)
//   4. identical content
// Name comes before identifier because preset authors sometimes rewrite an
// existing toggle into a different one (keeping its identifier) and re-create
// the old toggle under a new identifier. Readers go by name.
function comparePresetItems(A, B) {
    const pairs = [], usedA = new Set(), usedB = new Set();
    const matchId = (onlySystem, by) => {
        const bById = new Map();
        for (const b of B) if (!usedB.has(b) && !bById.has(b.id)) bById.set(b.id, b);
        for (const a of A) {
            if (usedA.has(a) || (onlySystem && !PRESET_SYSTEM_IDS.has(a.id))) continue;
            const b = bById.get(a.id);
            if (b && !usedB.has(b)) { pairs.push({ a, b, by }); usedA.add(a); usedB.add(b); }
        }
    };
    const matchBy = (keyOf, by) => {
        const group = (list, used) => {
            const m = new Map();
            for (const x of list) {
                if (used.has(x)) continue;
                const k = keyOf(x);
                if (k) m.set(k, m.has(k) ? null : x);      // null = ambiguous, skip
            }
            return m;
        };
        const ga = group(A, usedA), gb = group(B, usedB);
        for (const [k, a] of ga) {
            const b = gb.get(k);
            if (a && b) { pairs.push({ a, b, by }); usedA.add(a); usedB.add(b); }
        }
    };
    matchId(true, 'sys');
    matchBy(x => x.name.trim(), 'name');
    matchId(false, 'id');
    matchBy(x => (x.content.trim() ? x.content : ''), 'content');

    // Moved = paired toggles outside the longest common order.
    const pid = new Map(pairs.map((p, i) => [p, i]));
    const seqA = pairs.slice().sort((p, q) => p.a.idx - q.a.idx);
    const seqB = pairs.slice().sort((p, q) => p.b.idx - q.b.idx);
    const moved = new Set();
    const ord = diffSeq(seqA.map(p => pid.get(p)), seqB.map(p => pid.get(p)), 2000);
    if (ord) { for (const [t, , j] of ord) if (t === '+') moved.add(seqB[j]); }
    else pairs.forEach(p => { if (p.a.idx !== p.b.idx) moved.add(p); });

    const rowOfPair = new Map();
    for (const p of pairs) {
        const ch = {
            content: p.a.content !== p.b.content,
            name:    p.a.name !== p.b.name,
            enabled: p.a.enabled !== p.b.enabled,
            moved:   moved.has(p),
            conf:    diffPromptConf(p.a, p.b),
        };
        const any = ch.content || ch.name || ch.enabled || ch.moved || ch.conf.length > 0;
        rowOfPair.set(p, { st: any ? 'mod' : 'same', a: p.a, b: p.b, by: p.by, ch });
    }
    const rowOfB = new Map(), rowOfA = new Map();
    for (const [p, r] of rowOfPair) { rowOfB.set(p.b, r); rowOfA.set(p.a, r); }
    for (const b of B) if (!rowOfB.has(b)) rowOfB.set(b, { st: 'add', b, ch: {} });

    const head = [], after = new Map();
    let prev = null;
    for (const a of A) {
        if (rowOfA.has(a)) { prev = rowOfA.get(a); continue; }
        const r = { st: 'del', a, ch: {} };
        if (prev) { if (!after.has(prev)) after.set(prev, []); after.get(prev).push(r); }
        else head.push(r);
    }
    const out = head.slice();
    for (const b of B) {
        const r = rowOfB.get(b);
        out.push(r);
        if (after.has(r)) out.push(...after.get(r));
    }
    return out;
}

// Preset-level values. Only keys present on both sides are compared, and
// connection/credential fields are never read.
const DIFF_SKIP_KEYS = new Set(['prompts', 'prompt_order', 'extensions', 'connection_profile', 'preset_settings_openai', 'name', ...PRESET_CONNECTION_KEYS]);
const DIFF_SECRET_RE = /password|secret|api_?key|proxy|_url$|^custom_/i;
const DIFF_KEY_LABEL = {
    openai_max_context: '최대 컨텍스트', openai_max_tokens: '최대 응답 토큰', max_context_unlocked: '컨텍스트 제한 해제',
    stream_openai: '스트리밍', wrap_in_quotes: '따옴표로 감싸기', names_behavior: '이름 표시 방식',
    send_if_empty: '빈 메시지 대체 문구', squash_system_messages: '시스템 메시지 합치기',
    assistant_prefill: '프리필', assistant_impersonation: '사칭 프리필',
    continue_prefill: '이어쓰기 프리필', continue_postfix: '이어쓰기 접미사', continue_nudge_prompt: '이어쓰기 지시',
    impersonation_prompt: '사칭 프롬프트', new_chat_prompt: '새 채팅 프롬프트', new_group_chat_prompt: '새 그룹 채팅 프롬프트',
    new_example_chat_prompt: '예시 대화 프롬프트', group_nudge_prompt: '그룹 지시',
    wi_format: '월드인포 형식', scenario_format: '시나리오 형식', personality_format: '성격 형식',
    bias_preset_selected: '로짓 바이어스 프리셋', claude_use_sysprompt: 'Claude 시스템 프롬프트 사용',
    use_makersuite_sysprompt: 'Gemini 시스템 프롬프트 사용', function_calling: '함수 호출',
    show_thoughts: '생각 표시', enable_web_search: '웹 검색', request_images: '이미지 요청', image_inlining: '이미지 첨부',
};
function diffPresetSettings(sa, sb) {
    const rows = [];
    if (!sa || !sb) return rows;
    for (const k of Object.keys(sb)) {
        if (DIFF_SKIP_KEYS.has(k) || DIFF_SECRET_RE.test(k) || !Object.prototype.hasOwnProperty.call(sa, k)) continue;
        const a = sa[k], b = sb[k];
        if (typeof a === 'function' || typeof b === 'function') continue;
        let ja, jb;
        try { ja = typeof a === 'string' ? a : JSON.stringify(a); jb = typeof b === 'string' ? b : JSON.stringify(b); }
        catch (e) { continue; }
        if (ja === jb) continue;
        const isText = typeof a === 'string' && typeof b === 'string'
            && (a.length > 60 || b.length > 60 || a.includes('\n') || b.includes('\n'));
        rows.push({ key: k, a, b, isText });
    }
    return rows.sort((x, y) => x.key.localeCompare(y.key));
}

// Bundled regex / JS scripts, paired by name in order of appearance.
function diffBundleList(la, lb) {
    const out = [], byName = new Map(), usedB = new Set();
    lb.forEach((y, j) => { if (!byName.has(y.name)) byName.set(y.name, []); byName.get(y.name).push(j); });
    const fieldsOf = (ra, rb) => {
        const keys = new Set([...Object.keys(ra || {}), ...Object.keys(rb || {})]);
        keys.delete('id');
        const f = [];
        for (const k of keys) {
            let x, y;
            try { x = JSON.stringify(ra?.[k]); y = JSON.stringify(rb?.[k]); } catch (e) { continue; }
            if (x !== y) f.push(k);
        }
        return f;
    };
    for (const x of la) {
        const q = byName.get(x.name);
        const j = q && q.length ? q.shift() : -1;
        if (j < 0) { out.push({ st: 'del', name: x.name, a: x }); continue; }
        usedB.add(j);
        const f = fieldsOf(x.raw, lb[j].raw);
        out.push({ st: f.length ? 'mod' : 'same', name: x.name, a: x, b: lb[j], fields: f });
    }
    lb.forEach((y, j) => { if (!usedB.has(j)) out.push({ st: 'add', name: y.name, b: y }); });
    return out;
}

// Cached translations of a preset are keyed by the preset tab's namespace.
// (Translations stored under "no selection" are not used: which preset they
// belong to is unknown.)
const diffNsList = (name) => [`pt-preset::${name}`];
const diffFirst = (nsList, id, fn) => { for (const ns of nsList) { const v = fn(ns, id); if (v) return v; } return null; };

function ensureBundleCss() {
    if (PDOC.getElementById('pt-bundle-css')) return;
    const st = PDOC.createElement('style');
    st.id = 'pt-bundle-css';
    st.textContent = `
#pt-panel .pt-bundle{margin-top:12px;border-top:1px dashed var(--pt-border-strong,#8886);padding-top:6px}
#pt-panel .pt-bundle[hidden],#pt-panel .pt-bundle-body[hidden]{display:none!important}
#pt-panel .pt-bundle-head{display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;user-select:none;-webkit-user-select:none;font-size:11.5px;font-weight:700;color:var(--pt-text-dim,#888)}
#pt-panel .pt-bundle.open .pt-bundle-head .pt-block-chevron{transform:rotate(90deg)}
#pt-panel .pt-bundle-all{display:flex;align-items:center;gap:6px;padding:2px 4px 6px;font-size:11px;color:var(--pt-text-dim,#888);cursor:pointer}
#pt-panel .pt-bundle-list{display:flex;flex-direction:column;gap:6px}
#pt-panel .pt-bundle-flat .pt-block-header{cursor:default}
`;
    PDOC.head.appendChild(st);
}

function ensureReuseCss() {
    if (PDOC.getElementById('pt-reuse-css')) return;
    const st = PDOC.createElement('style');
    st.id = 'pt-reuse-css';
    st.textContent = `
#pt-panel .pt-reuse-bar{display:flex;align-items:center;gap:6px;margin:0 0 6px;padding:6px 8px;border-radius:10px;font-size:11px;line-height:1.45;border:1px solid var(--pt-border-strong,#888);background:var(--pt-accent-soft,rgba(91,123,213,.12));color:var(--pt-text,inherit)}
#pt-panel .pt-reuse-bar[hidden]{display:none!important}
#pt-panel .pt-reuse-msg{flex:1;min-width:0;overflow-wrap:anywhere}
#pt-panel .pt-reuse-bar button{flex:0 0 auto;height:26px;padding:0 10px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;border:1px solid var(--pt-accent-strong,#5b7bd5);background:transparent;color:var(--pt-accent-strong,#5b7bd5)}
#pt-panel .pt-reuse-bar .pt-reuse-x{padding:0 8px;border-color:transparent;color:var(--pt-text-dim,#888);font-weight:400}
`;
    PDOC.head.appendChild(st);
}

// ── List picker ───────────────────────────────────────────────────────
// A native <select> cannot hold a search box or buttons, so what the user
// taps is our own button plus a sheet. The native select stays in the DOM,
// hidden, as the one value holder: loading, export, Ask and compare keep
// reading sel.value exactly as before.
const PICK_CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

// One query character against one name character.
// - ㄱ…ㅎ also matches any syllable starting with that consonant (초성 search)
// - the last character, while still being typed without a final consonant,
//   also matches the same syllable with one: "하느" finds "하늘"
function pickCharMatch(q, n, isLast) {
    if (q.toLowerCase() === n.toLowerCase()) return true;
    const nc = n.charCodeAt(0) - 0xAC00;
    if (nc < 0 || nc > 11171) return false;
    if (q >= 'ㄱ' && q <= 'ㅎ') return PICK_CHO[Math.floor(nc / 588)] === q;
    const qc = q.charCodeAt(0) - 0xAC00;
    return isLast && qc >= 0 && qc <= 11171 && qc % 28 === 0 && Math.floor(qc / 28) === Math.floor(nc / 28);
}

// Position of term inside name, or -1
function pickFind(name, term) {
    const L = term.length;
    outer: for (let i = 0; i + L <= name.length; i++) {
        for (let j = 0; j < L; j++) {
            if (!pickCharMatch(term[j], name[i + j], j === L - 1)) continue outer;
        }
        return i;
    }
    return -1;
}

// Every space-separated term must match. Returns merged [start, end) ranges
// for highlighting, or null when the name does not match.
function pickMatch(name, terms) {
    const ranges = [];
    for (const t of terms) {
        const i = pickFind(name, t);
        if (i < 0) return null;
        ranges.push([i, i + t.length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
    }
    return merged;
}

function pickHighlight(name, ranges) {
    let out = '', at = 0;
    for (const [a, b] of ranges) {
        out += esc(name.slice(at, a)) + `<mark class="pt-highlight">${esc(name.slice(a, b))}</mark>`;
        at = b;
    }
    return out + esc(name.slice(at));
}

function ensurePickerCss() {
    if (PDOC.getElementById('pt-picker-css')) return;
    const st = PDOC.createElement('style');
    st.id = 'pt-picker-css';
    st.textContent = `
#pt-panel .pt-pk-native{display:none!important}
#pt-panel .pt-pk-btn{display:flex;align-items:center;gap:6px;text-align:left;font-family:inherit;line-height:1.2;background-image:none;-webkit-appearance:none;appearance:none}
#pt-panel .pt-pk-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
#pt-panel .pt-pk-btn.pt-pk-empty .pt-pk-label{opacity:.6}
#pt-panel .pt-pk-btn i{flex:0 0 auto;font-size:10px;opacity:.65}
#pt-panel .pt-pk-wrap{position:relative;display:flex;flex:1 1 auto;min-width:0}
#pt-panel .pt-pk-wrap>.pt-pk-btn{flex:1 1 auto;width:100%;min-width:0;max-width:none}
#pt-panel .pt-pk-btn.pt-pk-has-clear{padding-right:34px}
#pt-panel .pt-pk-btn.pt-pk-has-clear i{display:none}
#pt-panel .pt-pk-clear{position:absolute;right:3px;top:50%;transform:translateY(-50%);width:28px;height:28px;padding:0;margin:0;display:flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:transparent;color:var(--pt-text-dim,#999);font-size:13px;font-family:inherit;cursor:pointer}
#pt-panel .pt-pk-clear[hidden]{display:none}
#pt-panel .pt-pk-clear:hover{background:var(--pt-accent-soft,rgba(91,123,213,.12))}
#pt-panel .pt-pk-back{position:absolute;inset:0;z-index:10002;display:flex;justify-content:center;padding:8px;box-sizing:border-box;background:var(--pt-overlay,rgba(0,0,0,.5))}
#pt-panel .pt-pk-box{width:100%;max-width:560px;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-radius:12px;border:1px solid var(--pt-border-strong,#555);background:var(--pt-bg,#1a1a2e);color:var(--pt-text,#e0e0e0);box-shadow:0 10px 40px rgba(0,0,0,.3)}
#pt-panel .pt-pk-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--pt-border,#333)}
#pt-panel .pt-pk-title{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#pt-panel .pt-pk-count{flex:1;font-size:11px;color:var(--pt-text-dim,#999);white-space:nowrap}
#pt-panel .pt-pk-x{flex:0 0 auto;background:none;border:none;color:var(--pt-text-dim,#999);font-size:16px;cursor:pointer;padding:2px 6px}
#pt-panel .pt-pk-search{display:flex;align-items:center;gap:6px;padding:8px 12px}
#pt-panel .pt-pk-search input{flex:1;min-width:0;height:34px;box-sizing:border-box;padding:0 10px;border-radius:9px;font-size:12.5px;font-family:inherit;outline:none;border:1px solid var(--pt-border-strong,#555);background:var(--pt-select-bg,#222);color:var(--pt-select-text,#eee)}
#pt-panel .pt-pk-search input:focus{border-color:var(--pt-accent,#5b7bd5)}
#pt-panel .pt-pk-search input::placeholder{font-size:11.5px}
#pt-panel .pt-pk-tool{flex:0 0 auto;width:34px;height:34px;box-sizing:border-box;padding:0;display:flex;align-items:center;justify-content:center;border-radius:9px;font-size:15px;cursor:pointer;border:1px solid var(--pt-border-strong,#555);background:transparent;color:inherit}
#pt-panel .pt-pk-tool[aria-pressed="true"]{background:var(--pt-accent-soft,rgba(91,123,213,.15));border-color:var(--pt-accent,#5b7bd5)}
#pt-panel .pt-pk-tool:disabled{opacity:.45;cursor:default}
#pt-panel .pt-pk-bar{display:flex;align-items:center;gap:6px;margin:0 12px 8px;padding:5px 6px 5px 8px;border-radius:10px;font-size:11.5px;border:1px solid var(--pt-border-strong,#555);background:var(--pt-accent-soft,rgba(91,123,213,.12))}
#pt-panel .pt-pk-bar[hidden]{display:none}
#pt-panel .pt-pk-bar button{flex:0 0 auto;height:28px;padding:0 10px;border-radius:8px;font-size:11.5px;font-family:inherit;cursor:pointer;border:1px solid var(--pt-border-strong,#555);background:transparent;color:var(--pt-text,inherit)}
#pt-panel .pt-pk-bar .pt-pk-all{display:inline-flex;align-items:center;gap:6px;padding:0 6px;border-color:transparent}
#pt-panel .pt-pk-selcount{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--pt-text-dim,#999)}
#pt-panel .pt-pk-bar .pt-pk-go{font-weight:700;border-color:var(--pt-accent-strong,#5b7bd5);color:var(--pt-accent-strong,#5b7bd5)}
#pt-panel .pt-pk-bar button:disabled{opacity:.45;cursor:default}
#pt-panel .pt-pk-ck{flex:0 0 auto;width:16px;height:16px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;font-size:11px;line-height:1;color:#fff;border:1.5px solid var(--pt-border-strong,#888)}
#pt-panel .pt-pk-item.on .pt-pk-ck,#pt-panel .pt-pk-all[aria-pressed="true"] .pt-pk-ck{background:var(--pt-accent-strong,#5b7bd5);border-color:var(--pt-accent-strong,#5b7bd5)}
#pt-panel .pt-pk-item.on .pt-pk-ck::after,#pt-panel .pt-pk-all[aria-pressed="true"] .pt-pk-ck::after{content:"✓"}
#pt-panel .pt-pk-list{position:relative;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 8px 10px}
#pt-panel .pt-pk-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:10px;margin:0;border:0;border-bottom:1px solid var(--pt-border,#333);border-radius:8px;background:none;color:var(--pt-text,inherit);font-family:inherit;font-size:13px;line-height:1.4;text-align:left;cursor:pointer}
#pt-panel .pt-pk-item:hover{background:var(--pt-accent-soft,rgba(91,123,213,.12))}
#pt-panel .pt-pk-item.cur,#pt-panel .pt-pk-item.on{background:var(--pt-accent-soft,rgba(91,123,213,.12))}
#pt-panel .pt-pk-item.cur{font-weight:700}
#pt-panel .pt-pk-item.none{color:var(--pt-text-dim,#999);font-size:12px}
#pt-panel .pt-pk-item.act{color:var(--pt-accent-strong,#5b7bd5);font-weight:600}
#pt-panel .pt-pk-name{flex:1;min-width:0;overflow-wrap:anywhere}
#pt-panel .pt-pk-main{display:block}
#pt-panel .pt-pk-sub,#pt-panel .pt-pk-id{display:block;font-size:10.5px;font-weight:400;color:var(--pt-text-dim,#999)}
#pt-panel .pt-pk-item .fa-check{flex:0 0 auto;color:var(--pt-accent-strong,#5b7bd5)}
#pt-panel .pt-pk-sec{padding:8px 10px 3px;font-size:10.5px;font-weight:700;color:var(--pt-text-dim,#999)}
#pt-panel .pt-pk-empty-msg{padding:22px 10px;text-align:center;font-size:12px;color:var(--pt-text-dim,#999)}
`;
    PDOC.head.appendChild(st);
}

// Setting sel.value fires no event, so a bare assignment would leave the
// button showing one name while 📂 로드 reads another. Every programmatic
// change of a picker-backed select goes through here.
const PICKER_SYNC = new WeakMap();
function setSelValue(sel, v) {
    sel.value = v;
    PICKER_SYNC.get(sel)?.();
}

// ── Names of presets / world info / characters (shown in the panel only) ──
// Stored like toggle titles, in the translation cache under pt-names::{kind}
// (so cache backup carries them). ST's own dropdowns are never changed: ST
// reads the visible option text back as the preset name when switching.
const NAME_NS = kind => `pt-names::${kind}`;
const nameTr = (kind, id) => (kind ? getCachedTitle(NAME_NS(kind), id) : null);
const NAME_EYE = { preset: false, wi: false, char: false };     // 👀 per kind, this session only
const NAME_SYNC = { preset: new Set(), wi: new Set(), char: new Set() };
const syncNames = kind => NAME_SYNC[kind]?.forEach(fn => fn());
// With Korean as the target, a name with Hangul and no Chinese or Japanese
// characters is readable already and is not sent.
const nameNeedsNoTr = n => isKoTarget() && /[가-힣]/.test(n) && !/[぀-ヿ㐀-䶿一-鿿豈-﫿]/.test(n);

// picked: [{ id, name }]. Returns true when at least one name was translated.
async function runNameTranslation(kind, picked, onProgress) {
    const toast = (t, m) => { if (typeof toastr !== 'undefined') toastr[t](m); };
    if (isBusy) { toast('warning', '다른 번역이 끝난 뒤에 해 주세요'); return false; }
    const korean = picked.filter(p => nameNeedsNoTr(p.name));
    const asked = picked.filter(p => !nameNeedsNoTr(p.name));
    const fresh = asked.filter(p => !nameTr(kind, p.id));
    const already = asked.filter(p => nameTr(kind, p.id));
    const notes = [];
    if (korean.length) notes.push(`이미 한국어인 이름 ${korean.length}개 제외`);
    let targets = fresh;
    if (!fresh.length) {
        if (!already.length) { toast('info', korean.length ? '고른 이름이 모두 한국어라 번역하지 않았어요' : '번역할 이름이 없습니다'); return false; }
        const redo = confirm(`고른 이름 ${already.length}개가 이미 번역되어 있습니다.\n\n다시 번역할까요?\n\n[확인] = 재번역 (기존 이름 번역을 덮어씀)\n[취소] = 아무것도 하지 않음`);
        if (!redo) return false;
        targets = already;
    } else if (already.length) notes.push(`이미 번역된 ${already.length}개는 그대로`);

    isBusy = true;
    const dot = PDOC.getElementById('pt-status-dot'), stTxt = PDOC.getElementById('pt-status-text');
    dot?.classList.add('busy');
    if (stTxt) stTxt.textContent = '이름 번역 중...';
    let done = 0, okCount = 0, failCount = 0, firstErr = '';
    try {
        const bs = titleBatchSize();
        onProgress?.(0, targets.length);
        for (let i = 0; i < targets.length; i += bs) {
            const batch = targets.slice(i, i + bs);
            try {
                const tr = await translateTitleBatch(batch.map(p => p.name), `names-${kind}`);
                if (tr) { batch.forEach((p, k) => setCacheTitle(NAME_NS(kind), p.id, tr[k])); okCount += batch.length; }
                else { failCount += batch.length; if (!firstErr) firstErr = BATCH_MISMATCH; console.warn(`[${EXT}] name batch discarded (reply did not match ${batch.length} items)`); }
            } catch (err) {
                failCount += batch.length;
                if (!firstErr) firstErr = String(err?.message || err);
                console.warn(`[${EXT}] name batch failed`, err);
            }
            done += batch.length;
            onProgress?.(done, targets.length);
            if (done < targets.length) await new Promise(r => setTimeout(r, requestDelayMs()));
        }
    } finally {
        isBusy = false;
        dot?.classList.remove('busy');
        if (stTxt) stTxt.textContent = failCount ? `이름 번역 끝 · 실패 ${failCount}개` : '이름 번역 완료 ✓';
        statusIdleSoon();
    }
    const tail = notes.length ? ` (${notes.join(', ')})` : '';
    if (failCount) toast('warning', `이름 ${okCount}개 번역, ${failCount}개 실패${tail} — ${shortReason(firstErr)}`);
    else toast('success', `이름 ${okCount}개 번역 완료${tail}`);
    return okCount > 0;
}

// ── Recently loaded items, per kind (meta IndexedDB, newest first) ──
const RECENT_MAX = 5;
const RECENT = { preset: null, wi: null, char: null };          // null = not read yet
const recentKey = kind => `recent::${kind}`;
// One read per kind, shared by every caller, so a slow first read can never
// overwrite a newer push. Pushes run in order after it.
const recentReady = {};
function recentLoad(kind) {
    if (!kind) return Promise.resolve([]);
    if (!recentReady[kind]) {
        recentReady[kind] = metaGet(recentKey(kind))
            .then(v => (Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, RECENT_MAX) : []))
            .catch(() => [])
            .then(list => { RECENT[kind] = list; return list; });
    }
    return recentReady[kind];
}
function recentPush(kind, id) {
    if (!kind || !id) return;
    recentLoad(kind).then(() => {
        const next = [String(id), ...RECENT[kind].filter(x => x !== String(id))].slice(0, RECENT_MAX);
        RECENT[kind] = next;
        metaPut(recentKey(kind), next).catch(e => console.warn(`[${EXT}] recent list not saved`, e));
    });
}

// Puts the picker button after `sel` and hides `sel`.
// kind ('preset' | 'wi' | 'char') turns on name translation and recent items.
// Options may carry data-group (listed in their own section above the rest,
// left out of name translation), data-sub (small line), data-trid (id for
// the name translation) and data-suffix (added to the button label).
// extra.actions: [{ label, run }] rows shown at the top of the plain list.
// extra.clearable: a small ✕ on the button empties the choice.
function attachPicker(sel, title, kind, extra = {}) {
    const actions = extra.actions || [];
    ensurePickerCss();
    const win = sel.ownerDocument.defaultView || window;
    const btn = PDOC.createElement('button');
    btn.type = 'button';
    btn.className = 'pt-select pt-pk-btn';
    btn.dataset.for = sel.id;
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-label', title);
    btn.innerHTML = '<span class="pt-pk-label"></span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i>';
    sel.classList.add('pt-pk-native');
    let clearBtn = null;
    if (extra.clearable) {
        // The ✕ is a sibling laid over the button's right end (a button
        // cannot hold another button), so it never opens the list.
        const wrap = PDOC.createElement('span');
        wrap.className = 'pt-pk-wrap';
        sel.after(wrap);
        wrap.appendChild(btn);
        clearBtn = PDOC.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'pt-pk-clear';
        clearBtn.title = '비우기';
        clearBtn.setAttribute('aria-label', `${title} 비우기`);
        clearBtn.textContent = '✕';
        wrap.appendChild(clearBtn);
        clearBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (!sel.value) return;
            setSelValue(sel, '');
            sel.dispatchEvent(new win.Event('change', { bubbles: true }));
        });
    } else sel.after(btn);
    const label = btn.firstChild;

    const sync = () => {
        const o = sel.options[sel.selectedIndex];
        const orig = (o && o.value) ? (o.textContent || o.value) : '';
        const tr = (orig && NAME_EYE[kind]) ? nameTr(kind, o.dataset.trid ?? o.value) : null;
        const suffix = (orig && o.dataset.suffix) ? ` · ${o.dataset.suffix}` : '';
        label.textContent = (tr || orig) ? (tr || orig) + suffix : ((o ? o.textContent : '') || '— 선택 —');
        btn.title = orig + suffix;
        btn.classList.toggle('pt-pk-empty', !orig);
        if (clearBtn) { clearBtn.hidden = !orig; btn.classList.toggle('pt-pk-has-clear', !!orig); }
    };
    PICKER_SYNC.set(sel, sync);
    if (kind) NAME_SYNC[kind].add(sync);
    // Option refills (startup, ↻) are caught here; value changes go through setSelValue.
    let rerender = null;   // set while the sheet is open
    new win.MutationObserver(() => { sync(); rerender?.(); }).observe(sel, { childList: true });
    sync();

    const open = () => {
        const panel = sel.closest('#pt-panel');
        if (!panel || panel.querySelector('.pt-pk-back')) return;
        const back = PDOC.createElement('div');
        back.className = 'pt-pk-back';
        const tools = kind ? `<button type="button" class="pt-pk-tool pt-pk-tr" aria-pressed="false" title="이름 번역 — 번역할 이름을 골라요" aria-label="이름 번역">📛</button>`
            + `<button type="button" class="pt-pk-tool pt-pk-eye" aria-pressed="${NAME_EYE[kind] ? 'true' : 'false'}" title="번역된 이름으로 보기 (다시 누르면 원래 이름)" aria-label="번역된 이름으로 보기">👀</button>` : '';
        back.innerHTML = `<div class="pt-pk-box" role="dialog" aria-label="${esc(title)}">
            <div class="pt-pk-head"><span class="pt-pk-title">${esc(title)}</span><span class="pt-pk-count"></span><button type="button" class="pt-pk-x" aria-label="닫기">✕</button></div>
            <div class="pt-pk-search"><input type="search" placeholder="🔍 이름으로 찾기 (초성도 가능: ㄲㅆ)" autocomplete="off" enterkeyhint="search" aria-label="이름으로 찾기">${tools}</div>
            ${kind ? `<div class="pt-pk-bar" hidden><button type="button" class="pt-pk-all" aria-pressed="false"><span class="pt-pk-ck"></span>보이는 것 모두</button><span class="pt-pk-selcount"></span><button type="button" class="pt-pk-cancel">취소</button><button type="button" class="pt-pk-go">번역</button></div>` : ''}
            <div class="pt-pk-list"></div>
        </div>`;
        const q = s => back.querySelector(s);
        const input = q('input'), listEl = q('.pt-pk-list'), countEl = q('.pt-pk-count');
        const bar = q('.pt-pk-bar'), trBtn = q('.pt-pk-tr'), eyeBtn = q('.pt-pk-eye');
        let opts = [], visible = [];
        // 📛 mode: rows get check boxes and a tap ticks instead of picking
        let picking = false, running = false;
        const chosen = new Set();

        const updateBar = (progress) => {
            if (!bar) return;
            const allOn = visible.length > 0 && visible.every(v => chosen.has(v));
            q('.pt-pk-all').setAttribute('aria-pressed', allOn ? 'true' : 'false');
            q('.pt-pk-selcount').textContent = progress || (chosen.size ? `${chosen.size}개 고름` : '번역할 이름을 고르세요');
            q('.pt-pk-go').disabled = running || !chosen.size;
            q('.pt-pk-all').disabled = running;
            q('.pt-pk-cancel').disabled = running;
        };

        const render = () => {
            opts = [...sel.options].map(o => ({ value: o.value, name: o.textContent || o.value,
                group: o.dataset.group || '', sub: o.dataset.sub || '', trid: o.dataset.trid ?? o.value }));
            const real = opts.filter(o => o.value && !o.group);
            const twice = new Set(), seen = new Set();
            real.forEach(o => { if (seen.has(o.name)) twice.add(o.name); seen.add(o.name); });
            const terms = input.value.trim().split(/\s+/).filter(Boolean);
            const cur = sel.value;
            const eye = !!(kind && NAME_EYE[kind]);
            visible = [];
            const rowFor = (o, i) => {
                const tr = nameTr(kind, o.trid);
                const rOrig = terms.length ? pickMatch(o.name, terms) : [];
                const rTr = (tr && terms.length) ? pickMatch(tr, terms) : (tr ? [] : null);
                if (!rOrig && !rTr) return null;            // search: matches neither the name nor its translation
                let main = pickHighlight(o.name, rOrig || []), sub = '';
                if (eye && tr) { main = pickHighlight(tr, rTr || []); sub = pickHighlight(o.name, rOrig || []); }
                else if (tr && (picking || !rOrig)) sub = pickHighlight(tr, rTr || []);   // show why it matched / what it already has
                const idLine = (!o.group && twice.has(o.name)) ? `<span class="pt-pk-id">${esc(o.value)}</span>` : '';
                const subLine = o.sub ? `<span class="pt-pk-id">${esc(o.sub)}</span>` : '';
                const name = `<span class="pt-pk-name"><span class="pt-pk-main">${main}</span>${sub ? `<span class="pt-pk-sub">${sub}</span>` : ''}${idLine}${subLine}</span>`;
                if (picking) return `<button type="button" class="pt-pk-item${chosen.has(o.value) ? ' on' : ''}" data-i="${i}"><span class="pt-pk-ck"></span>${name}</button>`;
                const isCur = o.value === cur;
                return `<button type="button" class="pt-pk-item${isCur ? ' cur' : ''}" data-i="${i}">${name}${isCur ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : ''}</button>`;
            };
            const rows = [];
            let sections = 0;
            // Action rows (e.g. open a file) — plain list only
            if (!terms.length && !picking) actions.forEach((a, k) => rows.push(`<button type="button" class="pt-pk-item act" data-act="${k}"><span class="pt-pk-name">${esc(a.label)}</span></button>`));
            // Grouped options in their own sections; never in name translation
            if (!picking) {
                const groups = [];
                opts.forEach((o, i) => {
                    if (!o.value || !o.group) return;
                    let g = groups.find(x => x.name === o.group);
                    if (!g) groups.push(g = { name: o.group, rows: [] });
                    const h = rowFor(o, i);
                    if (h) g.rows.push(h);
                });
                for (const g of groups) if (g.rows.length) { rows.push(`<div class="pt-pk-sec">${esc(g.name)}</div>`, ...g.rows); sections++; }
            }
            // Recently loaded (plain list only)
            const recent = (!terms.length && !picking && kind && RECENT[kind]) ? RECENT[kind]
                .map(v => opts.findIndex(o => o.value === v && !o.group)).filter(i => i > 0) : [];
            if (recent.length) {
                rows.push('<div class="pt-pk-sec">최근</div>');
                recent.forEach(i => rows.push(rowFor(opts[i], i)));
                sections++;
            }
            const mainRows = [];
            let shown = 0;
            opts.forEach((o, i) => {
                if (o.group) return;
                if (!o.value) {
                    // The empty choice: kept as it was (on the preset tab it loads the live settings)
                    if (!terms.length && !picking) mainRows.push(`<button type="button" class="pt-pk-item none${cur === '' ? ' cur' : ''}" data-i="${i}"><span class="pt-pk-name">${esc(o.name)}</span></button>`);
                    return;
                }
                const html = rowFor(o, i);
                if (!html) return;
                shown++;
                visible.push(o.value);
                mainRows.push(html);
            });
            if (sections && shown) rows.push('<div class="pt-pk-sec">전체</div>');
            rows.push(...mainRows);
            countEl.textContent = terms.length ? `${real.length}개 중 ${shown}개` : `${real.length}개`;
            if (!real.length && !sections) rows.push('<div class="pt-pk-empty-msg">목록이 비어 있어요.<br>패널 위 ↻ 새로고침을 눌러 보세요.</div>');
            else if (terms.length && !shown && !sections) rows.push(`<div class="pt-pk-empty-msg">'${esc(input.value.trim())}'와 맞는 이름이 없어요.</div>`);
            listEl.innerHTML = rows.join('');
            updateBar();
        };

        const setPicking = (on) => {
            picking = on;
            if (!on) chosen.clear();
            if (bar) bar.hidden = !on;
            trBtn?.setAttribute('aria-pressed', on ? 'true' : 'false');
            render();
        };

        let timer = 0;
        const close = () => {
            clearTimeout(timer);
            rerender = null;
            back.remove();
        };
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 90); });
        back.addEventListener('click', async e => {
            if (e.target === back || e.target.closest('.pt-pk-x')) { close(); return; }
            if (e.target.closest('.pt-pk-tr')) { if (!running) setPicking(!picking); return; }
            if (e.target.closest('.pt-pk-eye')) {
                NAME_EYE[kind] = !NAME_EYE[kind];
                eyeBtn.setAttribute('aria-pressed', NAME_EYE[kind] ? 'true' : 'false');
                render(); syncNames(kind);
                return;
            }
            if (e.target.closest('.pt-pk-cancel')) { setPicking(false); return; }
            if (e.target.closest('.pt-pk-all')) {
                const allOn = visible.length > 0 && visible.every(v => chosen.has(v));
                visible.forEach(v => allOn ? chosen.delete(v) : chosen.add(v));
                render();
                return;
            }
            if (e.target.closest('.pt-pk-go')) {
                if (running || !chosen.size) return;
                const picked = opts.filter(o => o.value && chosen.has(o.value)).map(o => ({ id: o.value, name: o.name }));
                running = true; updateBar(); trBtn.disabled = true;
                let changed = false;
                try {
                    changed = await runNameTranslation(kind, picked, (d, n) => updateBar(`번역 중 ${d}/${n}`));
                } finally {
                    running = false; trBtn.disabled = false;
                }
                if (changed) {
                    NAME_EYE[kind] = true;
                    eyeBtn.setAttribute('aria-pressed', 'true');
                    syncNames(kind);
                    if (back.isConnected) setPicking(false);
                } else if (back.isConnected) updateBar();
                return;
            }
            const act = e.target.closest('.pt-pk-item.act');
            if (act) {
                // Runs inside the tap, so it may open a file chooser
                const a = actions[+act.dataset.act];
                close();
                a?.run();
                return;
            }
            const row = e.target.closest('.pt-pk-item');
            if (!row) return;
            const v = opts[+row.dataset.i]?.value;
            if (picking) {
                if (running || !v) return;
                chosen.has(v) ? chosen.delete(v) : chosen.add(v);
                listEl.querySelectorAll(`.pt-pk-item[data-i="${row.dataset.i}"]`).forEach(r => r.classList.toggle('on', chosen.has(v)));
                updateBar();
                return;
            }
            close();
            if (v == null || v === sel.value) return;
            setSelValue(sel, v);
            sel.dispatchEvent(new win.Event('change', { bubbles: true }));
        });
        // stopPropagation: ST also listens for Esc on the whole page (stops a reply
        // being generated, closes a message edit) — closing this list must not do that
        back.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btn.focus(); } });

        render();
        rerender = render;
        panel.appendChild(back);
        if (kind && !RECENT[kind]) recentLoad(kind).then(() => { if (rerender === render) render(); });
        // Start with the current item in view. Only this list scrolls —
        // scrollIntoView would also move ST's page behind the panel.
        const curRow = listEl.querySelector('.pt-pk-item.cur');
        if (curRow) listEl.scrollTop = Math.max(0, curRow.offsetTop - (listEl.clientHeight - curRow.offsetHeight) / 2);
        // Phones: no auto-focus, so the keyboard does not cover the list until asked for
        try { if (win.matchMedia?.('(pointer: fine)').matches) input.focus(); } catch (e) {}
    };
    btn.addEventListener('click', open);
    return btn;
}

function ensureDiffCss() {
    if (PDOC.getElementById('pt-diff-css')) return;
    const st = PDOC.createElement('style');
    st.id = 'pt-diff-css';
    st.textContent = `
#pt-panel #pt-tabs .pt-tab.pt-tab-mini{flex:0 0 auto;padding-left:11px;padding-right:11px}
#pt-panel .pt-df-pick{display:flex;flex-direction:column;gap:5px;margin-bottom:6px}
#pt-panel .pt-df-row{display:flex;align-items:center;gap:6px}
#pt-panel .pt-df-row .pt-select{flex:1 1 auto;min-width:0;max-width:none}
#pt-panel .pt-df-row .pt-btn{flex:0 0 auto;min-width:58px;white-space:nowrap}
#pt-panel .pt-df-row>.pt-btn,#pt-panel .pt-df-row>.pt-btn-icon{flex:0 0 58px;width:58px;min-width:58px;box-sizing:border-box}
#pt-panel .pt-df-tag{flex:0 0 22px;height:22px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;border-radius:6px;border:1px solid currentColor;font-size:11px;font-weight:800}
#pt-panel .pt-df-tag.a{color:var(--pt-bad,#d9534f)}
#pt-panel .pt-df-tag.b{color:var(--pt-ok,#2f9e6e)}
#pt-panel .pt-df-filters{display:flex;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:6px;scrollbar-width:none}
#pt-panel .pt-df-filters::-webkit-scrollbar{display:none}
#pt-panel .pt-df-chip{flex:0 0 auto;padding:3px 9px;border-radius:999px;font-size:11px;line-height:1.4;border:1px solid var(--pt-border-strong,#888);background:transparent;color:var(--pt-text-dim,#888);cursor:pointer;white-space:nowrap}
#pt-panel .pt-df-chip.on{font-weight:700;color:var(--pt-accent-strong,#5b7bd5);border-color:var(--pt-accent-strong,#5b7bd5);background:var(--pt-accent-soft,rgba(91,123,213,.12))}
#pt-panel .pt-df-note{font-size:10.5px;line-height:1.5;color:var(--pt-text-dim,#888);margin:0 0 6px}
#pt-panel .pt-df-st{flex:0 0 auto;font-size:9.5px;font-weight:800;padding:1px 6px;border-radius:6px;border:1px solid currentColor}
#pt-panel .pt-df-st.add{color:var(--pt-ok,#2f9e6e)}
#pt-panel .pt-df-st.del{color:var(--pt-bad,#d9534f)}
#pt-panel .pt-df-st.mod{color:var(--pt-warn,#c4842d)}
#pt-panel .pt-df-st.same{color:var(--pt-text-dim,#888)}
#pt-panel .pt-df-st.etc{color:var(--pt-accent-strong,#5b7bd5)}
#pt-panel .pt-df-names{flex:1;min-width:0;display:flex;flex-direction:column}
#pt-panel .pt-df-dim>.pt-block-header{opacity:.62}
#pt-panel .pt-df-names .pt-block-name{flex:none}
#pt-panel .pt-df-tr{font-size:10.5px;line-height:1.35;color:var(--pt-text-dim,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pt-panel .pt-df-mini{flex:0 0 auto;font-size:9.5px;line-height:1.5;padding:0 5px;border-radius:999px;border:1px solid var(--pt-border-strong,#888);color:var(--pt-text-dim,#888);white-space:nowrap}
#pt-panel .pt-df-meta{font-size:11px;line-height:1.65;color:var(--pt-text-dim,#888);margin:0 0 6px;overflow-wrap:anywhere}
#pt-panel .pt-df-text{max-height:55vh;overflow:auto;-webkit-overflow-scrolling:touch;font-size:var(--pt-original-size,11px);line-height:1.55;border:1px solid var(--pt-content-border,var(--pt-border,#8884));border-radius:9px;background:var(--pt-content-bg,transparent);color:var(--pt-content-text,var(--pt-text,inherit))}
#pt-panel .pt-df-l{display:flex;gap:5px;padding:0 6px 0 3px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
#pt-panel .pt-df-g{flex:0 0 9px;text-align:center;opacity:.65;user-select:none;-webkit-user-select:none}
#pt-panel .pt-df-t{flex:1;min-width:0}
#pt-panel .pt-df-l.del{background:rgba(220,60,70,.12)}
#pt-panel .pt-df-l.del .pt-df-t{text-decoration:line-through;text-decoration-color:rgba(220,60,70,.75)}
#pt-panel .pt-df-l.ins{background:rgba(40,170,90,.13)}
#pt-panel .pt-df-l.mod{background:rgba(127,127,127,.07)}
#pt-panel .pt-df-text del{background:rgba(220,60,70,.27);color:inherit;text-decoration:line-through;text-decoration-color:rgba(220,60,70,.9)}
#pt-panel .pt-df-text ins{background:rgba(40,170,90,.30);color:inherit;text-decoration:none}
#pt-panel .pt-df-more{display:block;width:100%;padding:2px 0;font-size:10.5px;border:0;border-top:1px dashed var(--pt-border-strong,#8886);border-bottom:1px dashed var(--pt-border-strong,#8886);background:transparent;color:var(--pt-text-dim,#888);cursor:pointer}
#pt-panel .pt-df-hid[hidden]{display:none!important}
#pt-panel .pt-df-sec{margin-top:8px}
#pt-panel .pt-df-sec>summary{cursor:pointer;font-size:11px;color:var(--pt-text-dim,#888)}
#pt-panel .pt-df-sub{padding:6px 0;border-top:1px dashed var(--pt-border,#8884)}
#pt-panel .pt-df-sub:first-child{border-top:0}
#pt-panel .pt-df-subhead{display:flex;align-items:center;gap:6px;font-size:11.5px;margin-bottom:4px;overflow-wrap:anywhere}
#pt-panel .pt-df-actions{display:flex;gap:6px;margin-top:8px}
#pt-panel .pt-df-actions button{flex:1;height:28px;border-radius:8px;font-size:11px;cursor:pointer;border:1px solid var(--pt-border-strong,#888);background:transparent;color:var(--pt-text-dim,#888)}
`;
    PDOC.head.appendChild(st);
}

let refillDiffLists = null;   // set by the compare tab; used by ↻
function buildDiffPage(page) {
    ensureDiffCss();
    page.innerHTML = `
        <div class="pt-page-fixed">
            <div class="pt-df-pick">
                <div class="pt-df-row">
                    <span class="pt-df-tag a" title="기준 (이전 · 원본)">A</span>
                    <select class="pt-select" id="pt-diffa-sel" aria-label="A 프리셋"></select>
                    <button class="pt-btn-icon" id="pt-diff-swap" title="A와 B 바꾸기" aria-label="A와 B 바꾸기">⇅</button>
                </div>
                <div class="pt-df-row">
                    <span class="pt-df-tag b" title="비교 대상 (새 것 · 수정본)">B</span>
                    <select class="pt-select" id="pt-diffb-sel" aria-label="B 프리셋"></select>
                    <button class="pt-btn pt-btn-primary" id="pt-diff-run">비교</button>
                </div>
            </div>
            <div class="pt-reuse-bar" id="pt-diff-fileoffer" hidden></div>
            <input type="file" id="pt-diff-file" accept=".json,application/json" hidden>
            <div class="pt-df-note" id="pt-diff-note" style="display:none;"></div>
            <div class="pt-df-filters" id="pt-diff-filters" style="display:none;"></div>
        </div>
        <div class="pt-page-scroll">
            <div class="pt-block-list" id="pt-diff-list"></div>
            <div class="pt-empty" id="pt-diff-empty">
                <div class="pt-empty-icon">⇄</div>
                <p id="pt-diff-msg">두 프리셋을 고르고 비교를 누르세요.<br><small>A = 기준(이전·원본) · B = 비교 대상(새 것·수정본)</small></p>
            </div>
        </div>`;

    const selA = page.querySelector('#pt-diffa-sel'), selB = page.querySelector('#pt-diffb-sel');
    const fileInput = page.querySelector('#pt-diff-file'), offer = page.querySelector('#pt-diff-fileoffer');
    attachPicker(selA, 'A 프리셋 고르기 · 기준', 'preset', { clearable: true, actions: [{ label: '📁 파일에서 열기 (이번 접속 동안만)', run: () => fileInput.click() }] });
    attachPicker(selB, 'B 프리셋 고르기 · 비교 대상', 'preset', { clearable: true });
    const list = page.querySelector('#pt-diff-list'), empty = page.querySelector('#pt-diff-empty');
    const msg = page.querySelector('#pt-diff-msg'), note = page.querySelector('#pt-diff-note');
    const filters = page.querySelector('#pt-diff-filters');
    const toast = (type, text) => { if (typeof toastr !== 'undefined') toastr[type](text); };

    // A can also be a preserved original (orig/NAME) or a file opened this
    // session (file/). "/" cannot appear in an ST preset name (it is a file
    // name), so these values never collide with a real preset.
    let diffFile = null;   // { name, label, body } — memory only, gone on reload
    const fill = (sel) => {
        const keep = sel.value;
        let html = ['<option value="">— 선택 —</option>']
            .concat(listAllPresets().map(it => `<option value="${esc(it.id)}">${esc(it.name)}</option>`));
        if (sel === selA) {
            if (diffFile) html.push(`<option value="file/" data-group="열어 둔 파일" data-sub="새로고침하면 사라져요" data-trid="${esc(diffFile.name)}">📁 ${esc(diffFile.label)}</option>`);
            for (const e of (ORIG_INDEX || [])) {
                html.push(`<option value="${esc('orig/' + e.name)}" data-group="보존본" data-suffix="보존본" data-trid="${esc(e.name)}" data-sub="${esc(`${fmtDay(e.savedAt)} 보존 · ${fmtBytes(e.size)}`)}">${esc(e.name)}</option>`);
            }
        }
        sel.innerHTML = html.join('');
        if (keep && [...sel.options].some(o => o.value === keep)) setSelValue(sel, keep);
    };
    fill(selA); fill(selB);
    refillDiffLists = () => { fill(selA); fill(selB); };
    ORIG_LISTENERS.add(() => fill(selA));
    origIndexLoad().then(() => fill(selA));
    try { const cur = getCurrentPresetName(); if (cur && [...selB.options].some(o => o.value === cur)) setSelValue(selB, cur); } catch (e) {}

    // Result state (snapshot; replaced on every compare)
    let all = [], filter = 'changed', renderGen = 0, snap = null, noteHtml = '';

    // The list stays on the last result; flag it when the pickers no longer match.
    const syncNote = () => {
        if (!snap) return;
        note.innerHTML = (selA.value === snap.na && selB.value === snap.nb)
            ? noteHtml : '선택이 바뀌었습니다. <b>비교</b>를 다시 눌러 주세요.';
    };
    selA.addEventListener('change', syncNote);
    selB.addEventListener('change', syncNote);
    page.querySelector('#pt-diff-swap').addEventListener('click', () => {
        if (/^(orig|file)\//.test(selA.value) && !isInstalledPreset(selA.value)) {
            toast('info', '보존본과 파일은 A(기준)에만 둘 수 있어요');
            return;
        }
        const a = selA.value; setSelValue(selA, selB.value); setSelValue(selB, a);
        syncNote();
    });

    // B's preserved original goes into A when A is empty — and keeps following
    // B while A still holds what was put there automatically. A picked by
    // hand (from the list or a file) stays until changed or emptied with ✕.
    let aAuto = false;   // A holds an original that the auto-find put there (⇅ never moves one)
    selA.addEventListener('change', () => { aAuto = false; });   // fired only by user actions
    const autoOriginal = async (fromRun) => {
        if (!selB.value || (selA.value && !aAuto)) return false;
        const before = selA.value, b = selB.value;
        let res;
        try { res = await origFindFor(b); } catch (e) { console.warn(`[${EXT}] original lookup`, e); return false; }
        if (selA.value !== before || selB.value !== b) return false;   // changed meanwhile
        if (res.pick) {
            const v = 'orig/' + res.pick.name;
            if (v === before) return true;
            fill(selA);
            setSelValue(selA, v);
            aAuto = true;
            syncNote();
            toast('info', before
                ? `A를 '${res.pick.name}' 원본으로 바꿨어요 (${fmtDay(res.pick.savedAt)} 보존)`
                : `A에 보존된 원본을 넣었어요: ${res.pick.name} (${fmtDay(res.pick.savedAt)} 보존)`);
            return true;
        }
        if (before) {
            toast('info', res.candidates.length
                ? `'${b}'의 원본 후보가 ${res.candidates.length}개예요. A 목록의 '보존본'에서 골라 주세요 (A는 그대로)`
                : `'${b}'의 보존된 원본이 없어 A는 그대로예요. 비우려면 A의 ✕를 누르세요`);
            return false;
        }
        if (res.candidates.length) toast('info', `보존된 원본 후보가 ${res.candidates.length}개예요. A 목록의 '보존본'에서 골라 주세요`);
        else if (fromRun) toast('warning', '비교할 프리셋 두 개를 고르세요');
        return false;
    };
    selB.addEventListener('change', () => { if ((!selA.value || aAuto) && ORIG_INDEX?.length) autoOriginal(false); });

    // 📁 파일에서 열기: read a preset file into memory only
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';                   // the same file can be picked again
        if (!file) return;
        if (file.size > 30 * 1024 * 1024) { toast('error', '파일이 너무 커요 (최대 30MB)'); return; }
        let data;
        try { data = JSON.parse(await file.text()); }
        catch (e) { toast('error', 'JSON 파일을 읽을 수 없어요'); return; }
        if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.prompts) || !presetItemsOf(data, true).length) {
            toast('error', '채팅 완성(Chat Completion) 프리셋 파일만 열 수 있어요');
            return;
        }
        const base = file.name.replace(/\.[^/.]+$/, '') || file.name;
        diffFile = { name: base, label: file.name, body: origStrip(data) };
        fill(selA);
        setSelValue(selA, 'file/');
        selA.dispatchEvent(new (selA.ownerDocument.defaultView || window).Event('change', { bubbles: true }));
        ensureReuseCss();
        offer.innerHTML = `<span class="pt-reuse-msg">파일로 불러온 프리셋을 보존본으로 따로 저장할까요? <small>(앞으로 매번 파일을 불러오지 않아도 됩니다)</small></span>`
            + `<button type="button" data-act="keep">저장</button><button type="button" class="pt-reuse-x" data-act="no" aria-label="닫기">✕</button>`;
        offer.hidden = false;
    });
    offer.addEventListener('click', async ev => {
        const b = ev.target.closest('[data-act]');
        if (!b) return;
        if (b.dataset.act === 'no' || !diffFile) { offer.hidden = true; return; }
        b.disabled = true;
        try {
            const res = await origSaveAsking(diffFile.name, diffFile.body, 'file');
            if (res === 'kept') { b.disabled = false; return; }
            toast(res === 'same' ? 'info' : 'success', res === 'same' ? '이미 같은 내용으로 보존되어 있어요' : `'${diffFile.name}' 이름으로 보존했어요`);
            offer.hidden = true;
        } catch (e) {
            console.warn(`[${EXT}] keep file as original`, e);
            toast('error', '보존하지 못했어요 (브라우저 저장소 오류)');
            b.disabled = false;
        }
    });

    // What a compare side reads: an installed preset, a preserved original, or the open file
    const readSide = async (v) => {
        if (isInstalledPreset(v) || !/^(orig|file)\//.test(v)) {
            const P = readPresetForDiff(v);
            return P ? { ...P, trName: v, label: v } : null;
        }
        let body, trName, label;
        if (v === 'file/') {
            if (!diffFile) return null;
            ({ body } = diffFile); trName = diffFile.name; label = `파일 ${diffFile.label}`;
        } else {
            const rec = await origGet(v.slice(5));
            if (!rec) return null;
            body = rec.body; trName = v.slice(5); label = `${trName} 보존본`;
        }
        return { name: trName, trName, label, isLive: false, items: presetItemsOf(body, true), settings: body, bundles: collectBundled(body.extensions) };
    };

    const FILTERS = [
        ['all',     '전체',      () => true],
        ['changed', '변경',      r => r.st !== 'same'],
        ['add',     '추가',      r => r.st === 'add'],
        ['del',     '삭제',      r => r.st === 'del'],
        ['content', '내용',      r => !!r.ch?.content],
        ['enabled', 'ON/OFF',    r => !!r.ch?.enabled],
        ['moved',   '순서',      r => !!r.ch?.moved],
        ['name',    '이름',      r => !!r.ch?.name],
        ['conf',    '위치·역할', r => (r.ch?.conf?.length || 0) > 0],
        ['etc',     '기타',      r => !!r.extra && r.st !== 'same'],
        ['same',    '동일',      r => r.st === 'same'],
    ];
    const ST_LABEL = { add: '추가', del: '삭제', mod: '변경', same: '동일' };

    const renderFilters = () => {
        filters.innerHTML = FILTERS.map(([key, label, fn]) => {
            const n = all.filter(fn).length;
            if (!n && key !== 'all' && key !== 'changed' && key !== filter) return '';
            return `<button type="button" class="pt-df-chip${key === filter ? ' on' : ''}" data-f="${key}">${label} ${n}</button>`;
        }).join('');
        filters.style.display = '';
    };

    const makeItem = (r, k) => {
        const el = PDOC.createElement('div');
        // In the full view, unchanged rows are toned down so changes stand out
        el.className = 'pt-block-item' + (filter === 'all' && r.st === 'same' ? ' pt-df-dim' : '');
        el.dataset.k = String(k);
        let badges = '', title = '', sub = '';
        if (r.extra) {
            title = r.title;
            badges = r.chips.map(c => `<span class="pt-df-mini">${esc(c)}</span>`).join('');
        } else {
            const it = r.b || r.a;
            title = it.name;
            const own = diffFirst(diffNsList(r.b ? snap.tb : snap.ta), it.id, (n, id) => getTranslatedTitle(n, id, it.name));
            // A's translated title is borrowed only when the toggle kept its name;
            // after a rename it would be the title of a different name.
            const borrowed = (!own && r.a && r.b && r.a.name === r.b.name)
                ? diffFirst(diffNsList(snap.ta), r.a.id, getTranslatedTitle) : null;
            sub = own || borrowed || '';
            if (sub && sub === title) sub = '';
            if (r.st === 'mod') {
                const c = [];
                if (r.ch.content) c.push('내용');
                if (r.ch.name) c.push('이름');
                if (r.ch.enabled) c.push(r.b.enabled ? 'OFF→ON' : 'ON→OFF');
                if (r.ch.moved) c.push('순서');
                if (r.ch.conf.length) c.push('위치·역할');
                badges = c.map(x => `<span class="pt-df-mini">${x}</span>`).join('');
            }
            if (!(r.st === 'mod' && r.ch.enabled)) {
                badges += `<span class="pt-status-badge ${it.enabled ? 'pt-status-on' : 'pt-status-off'}">${it.enabled ? 'ON' : 'OFF'}</span>`;
            }
        }
        const st = r.extra ? 'etc' : r.st;
        el.innerHTML = `
            <div class="pt-block-header">
                <span class="pt-df-st ${st}">${r.extra ? (r.st === 'same' ? '동일' : '기타') : ST_LABEL[r.st]}</span>
                <span class="pt-df-names"><span class="pt-block-name" title="${esc(title)}">${esc(title)}</span>${sub ? `<span class="pt-df-tr">${esc(sub)}</span>` : ''}</span>
                ${badges}
                <span class="pt-block-chevron">▶</span>
            </div>
            <div class="pt-block-body"></div>`;
        return el;
    };

    const plainBox = (label, text) => text
        ? `<div class="pt-original-label">${label}</div><div class="pt-original-text">${esc(text)}</div>`
        : `<div class="pt-df-note">${label}: (비어 있음)</div>`;

    const fillBody = (body, r) => {
        let h = '';
        if (r.extra === 'settings') {
            h = r.rows.map(x => {
                const label = DIFF_KEY_LABEL[x.key] ? `${esc(DIFF_KEY_LABEL[x.key])} <small>(${esc(x.key)})</small>` : esc(x.key);
                if (x.isText) return `<div class="pt-df-sub"><div class="pt-df-subhead">${label}</div><div class="pt-df-text">${renderTextDiff(x.a, x.b)}</div></div>`;
                const show = v => { let s; try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); } s = s === undefined ? '(없음)' : s; return esc(s.length > 160 ? s.slice(0, 160) + '…' : s); };
                return `<div class="pt-df-sub"><div class="pt-df-subhead">${label}</div><div class="pt-df-meta" style="margin:0">A: ${show(x.a)}<br>B: ${show(x.b)}</div></div>`;
            }).join('') || `<div class="pt-df-note">${r.ok ? '차이 없음' : '저장된 프리셋 사본을 찾지 못해 설정값은 비교하지 않았습니다.'}</div>`;
        } else if (r.extra === 'regex' || r.extra === 'scripts') {
            const textKeys = r.extra === 'regex' ? ['findRegex', 'replaceString'] : ['content'];
            h = r.rows.filter(x => x.st !== 'same').map(x => {
                let inner = '';
                if (x.st === 'mod') {
                    const other = x.fields.filter(f => !textKeys.includes(f));
                    if (other.length) inner += `<div class="pt-df-meta" style="margin:0 0 4px">바뀐 항목: ${other.map(esc).join(', ')}</div>`;
                    for (const f of textKeys) {
                        if (!x.fields.includes(f)) continue;
                        inner += `<div class="pt-df-meta" style="margin:0 0 2px">${esc(f)}</div><div class="pt-df-text">${renderTextDiff(x.a.raw?.[f], x.b.raw?.[f])}</div>`;
                    }
                } else {
                    inner = `<div class="pt-df-meta" style="margin:0">${x.st === 'add' ? 'B에만 있음' : 'A에만 있음'}</div>`;
                }
                return `<div class="pt-df-sub"><div class="pt-df-subhead"><span class="pt-df-st ${x.st}">${ST_LABEL[x.st]}</span>${esc(x.name)}</div>${inner}</div>`;
            }).join('') || '<div class="pt-df-note">차이 없음</div>';
        } else {
            const { a, b } = r;
            const meta = [];
            if (r.st === 'mod') {
                if (r.ch.name) meta.push(`이름: ${esc(a.name)} → ${esc(b.name)}`);
                if (r.ch.enabled) meta.push(`ON/OFF: ${a.enabled ? '켜짐' : '꺼짐'} → ${b.enabled ? '켜짐' : '꺼짐'}`);
                if (r.ch.moved) meta.push(`순서: ${a.idx + 1}번째 → ${b.idx + 1}번째`);
                for (const [l, x, y] of r.ch.conf) meta.push(`${l}: ${esc(String(x))} → ${esc(String(y))}`);
                if (r.by === 'id' && r.ch.name) meta.push('※ 이름은 다르지만 내부 식별자가 같아 같은 토글로 봤습니다');
                if (r.by === 'name' && a.id !== b.id) meta.push('※ 내부 식별자는 다르지만 이름이 같아 같은 토글로 봤습니다');
                if (r.by === 'content') meta.push('※ 식별자·이름이 달라 같은 내용으로 짝지었습니다');
                if (r.ch.content) meta.push(`토큰(추정): ${estimateTokens(stripMacroComments(a.content)).toLocaleString()} → ${estimateTokens(stripMacroComments(b.content)).toLocaleString()}`);
            } else if (r.st === 'add') meta.push('B에만 있는 토글입니다');
            else if (r.st === 'del') meta.push('A에만 있는 토글입니다');
            if (meta.length) h += `<div class="pt-df-meta">${meta.join('<br>')}</div>`;
            if (r.st === 'mod' && r.ch.content) {
                h += `<div class="pt-original-label">내용 차이 <small>(− 취소선 = A에만 · + 초록 = B에만)</small></div><div class="pt-df-text">${renderTextDiff(a.content, b.content)}</div>`;
            } else {
                h += plainBox('내용', (b || a).content);
            }
            // Cached translation, for reading a foreign-language preset. It may
            // predate the current text, so it is only offered as a reference.
            const it = b || a;
            const trOwn = diffFirst(diffNsList(b ? snap.tb : snap.ta), it.id, getTranslatedBody);
            const trA = !trOwn && a && b ? diffFirst(diffNsList(snap.ta), a.id, getTranslatedBody) : null;
            const tr = trOwn || trA;
            if (tr) h += `<details class="pt-df-sec"><summary>${trA ? 'A(이전) 번역 참고' : '번역 참고'} (원문 수정 전 번역일 수 있음)</summary><div class="pt-translated-text">${esc(tr)}</div></details>`;
            h += `<div class="pt-df-actions">${a ? '<button type="button" data-act="copy-a">A 내용 복사</button>' : ''}${b ? '<button type="button" data-act="copy-b">B 내용 복사</button>' : ''}</div>`;
        }
        body.innerHTML = h;
    };

    const renderList = () => {
        const gen = ++renderGen;
        list.innerHTML = '';
        const fn = (FILTERS.find(f => f[0] === filter) || FILTERS[0])[2];
        const shown = [];
        all.forEach((r, k) => { if (fn(r)) shown.push(k); });
        if (!shown.length) {
            empty.style.display = '';
            msg.textContent = filter === 'changed' ? '두 프리셋의 토글·설정이 모두 같습니다.' : '해당하는 항목이 없습니다.';
            return;
        }
        empty.style.display = 'none';
        let i = 0;
        const chunk = () => {
            if (gen !== renderGen) return;
            const end = Math.min(i + 50, shown.length), frag = PDOC.createDocumentFragment();
            for (; i < end; i++) frag.appendChild(makeItem(all[shown[i]], shown[i]));
            list.appendChild(frag);
            if (i < shown.length) requestAnimationFrame(chunk);
        };
        chunk();
    };

    filters.addEventListener('click', ev => {
        const b = ev.target.closest('.pt-df-chip');
        if (!b) return;
        filter = b.dataset.f;
        renderFilters();
        renderList();
    });

    list.addEventListener('click', async ev => {
        const act = ev.target.closest('[data-act]');
        if (act && list.contains(act)) {
            if (act.dataset.act === 'unfold') {
                const hid = act.nextElementSibling;
                if (hid) hid.hidden = false;
                act.remove();
                return;
            }
            const r = all[+act.closest('.pt-block-item')?.dataset.k];
            const side = act.dataset.act === 'copy-a' ? r?.a : r?.b;
            if (!side) return;
            const ok = await copyTextToClipboard(side.content || '');
            toast(ok ? 'success' : 'error', ok ? '복사했습니다' : '복사 실패');
            return;
        }
        const head = ev.target.closest('.pt-block-header');
        if (!head || !list.contains(head)) return;
        const item = head.parentElement;
        if (!item.dataset.filled) {
            const r = all[+item.dataset.k];
            try { fillBody(item.querySelector('.pt-block-body'), r); }
            catch (e) {
                console.error(`[${EXT}] diff body`, e);
                item.querySelector('.pt-block-body').innerHTML = `<div class="pt-df-note">표시 오류: ${esc(String(e?.message || e))}</div>`;
            }
            item.dataset.filled = '1';
        }
        item.classList.toggle('expanded');
    });

    const runBtn = page.querySelector('#pt-diff-run');
    runBtn.addEventListener('click', async () => {
        if (!selA.value && selB.value && !(await autoOriginal(true))) return;
        const na = selA.value, nb = selB.value;
        if (!na || !nb) { toast('warning', '비교할 프리셋 두 개를 고르세요'); return; }
        if (na === nb) { toast('warning', 'A와 B가 같은 프리셋입니다'); return; }
        let A, B;
        runBtn.disabled = true;
        try { A = await readSide(na); B = await readSide(nb); }
        catch (e) { console.error(`[${EXT}] diff read`, e); toast('error', `프리셋 읽기 실패: ${e?.message || e}`); return; }
        finally { runBtn.disabled = false; }
        if (!A || !B) { toast('error', `프리셋을 찾을 수 없습니다: ${!A ? na : nb}`); return; }
        if (selA.value !== na || selB.value !== nb) return;   // changed while reading
        try {
            const rows = comparePresetItems(A.items, B.items);
            const extras = [];
            const sRows = diffPresetSettings(A.settings, B.settings);
            const sOk = !!(A.settings && B.settings);
            extras.push({ extra: 'settings', title: '⚙️ 프리셋 설정값', st: sRows.length ? 'mod' : 'same',
                rows: sRows, ok: sOk, chips: [!sOk ? '저장본 없음' : sRows.length ? `${sRows.length}개 다름` : '차이 없음'], ch: {} });
            for (const [key, title] of [['regex', '🧩 동봉 정규식'], ['scripts', '📜 동봉 스크립트']]) {
                const d = diffBundleList(A.bundles[key], B.bundles[key]);
                const c = { add: 0, del: 0, mod: 0 };
                d.forEach(x => { if (c[x.st] != null) c[x.st]++; });
                const chips = [c.add && `추가 ${c.add}`, c.del && `삭제 ${c.del}`, c.mod && `변경 ${c.mod}`].filter(Boolean);
                extras.push({ extra: key, title, st: chips.length ? 'mod' : 'same', rows: d,
                    chips: chips.length ? chips : [d.length ? `${d.length}개 · 차이 없음` : '없음'], ch: {} });
            }
            snap = { na, nb, ta: A.trName, tb: B.trName };
            all = rows.concat(extras);
            filter = 'changed';
            const live = [A.isLive && 'A', B.isLive && 'B'].filter(Boolean);
            // How many toggles have a cached translation (full or title-only) —
            // shows at a glance whether translations can appear here at all.
            const trCount = (P) => {
                const nsl = diffNsList(P.trName);
                return P.items.filter(it => diffFirst(nsl, it.id, (n, id) => getTranslated(n, id) || getCachedTitle(n, id))).length;
            };
            const srcNote = [A, B].map((P, k) => P.label !== P.trName ? `${k ? 'B' : 'A'} = ${esc(P.label)}` : '').filter(Boolean).join(' · ');
            noteHtml = (srcNote ? srcNote + '<br>' : '') + `A ${A.items.length}개 · B ${B.items.length}개 토글 · 번역된 토글 A ${trCount(A)} · B ${trCount(B)}`
                + (live.length ? ` · <b>${live.join('·')}</b>는 현재 선택된 프리셋이라 토글은 저장 전 작업 상태, 설정값은 저장본 기준` : '');
            note.innerHTML = noteHtml;
            note.style.display = '';
            renderFilters();
            renderList();
        } catch (e) {
            console.error(`[${EXT}] diff`, e);
            toast('error', `비교 실패: ${e?.message || e}`);
        }
    });
}

// ── Page factory ──────────────────────────────────────────────────────
function buildPage({ page, idPfx, listFn, loadFn, selectable, icon, hint, isAsync, kind }) {
    let items=[], ns='', loadedVal='', loadedNoPick=false;   // loadedNoPick: loaded with "— 선택 —"

    // Buttons + search on same row
    page.innerHTML = `
        <div class="pt-page-fixed">
            <div class="pt-toolbar">
                <select class="pt-select" id="${idPfx}-sel"><option value="">— 선택 —</option></select>
                <button class="pt-btn pt-btn-secondary" id="${idPfx}-load">📂 로드</button>
                <div class="pt-export-group">
                    <button class="pt-btn-icon" id="${idPfx}-copy" title="복사"><i class="fa-solid fa-copy"></i></button>
                    <button class="pt-btn-icon" id="${idPfx}-txt" title="TXT 내보내기"><i class="fa-solid fa-file-lines"></i></button>
                    <button class="pt-btn-icon" id="${idPfx}-json" title="JSON 내보내기"><i class="fa-solid fa-file-code"></i></button>
                </div>
            </div>
            <div class="pt-progress-wrap" id="${idPfx}-prog">
                <div class="pt-progress-bar-outer"><div class="pt-progress-bar-inner" id="${idPfx}-pbar"></div></div>
                <div class="pt-progress-label" id="${idPfx}-plbl"></div>
            </div>
            <div class="pt-controls" id="${idPfx}-ctrl" style="display:none;">
                <div class="pt-controls-scroll">
                    <button class="pt-btn pt-btn-primary" id="${idPfx}-trans">✦ 번역</button>
                    <button class="pt-btn pt-btn-retr"    id="${idPfx}-retr">↺ 재번역</button>
                    <button class="pt-btn pt-btn-title"   id="${idPfx}-titles" title="제목만 빠르게 번역 (본문은 그대로)">📛 제목</button>
                    <button class="pt-btn pt-btn-stop"    id="${idPfx}-stop" disabled>■ 중단</button>
                    <button class="pt-btn pt-btn-danger"  id="${idPfx}-clr" title="번역 캐시 비우기">🗑</button>
                    <button class="pt-btn-icon pt-btn-eye" id="${idPfx}-eye" title="토글 제목을 번역본으로 보기 (다시 누르면 원어로)" aria-pressed="false">👀</button>
                    ${kind === 'preset' ? `<button class="pt-btn pt-btn-secondary" id="${idPfx}-orig" title="실리태번에 저장된 이 프리셋을 원본으로 보관 (비교 탭에서 기준으로 쓸 수 있음)">📥 원본 보존</button>` : ''}
                </div>
                <input type="text" class="pt-search" id="${idPfx}-search" placeholder="🔍 검색">
            </div>
            ${kind === 'preset' ? `<div class="pt-reuse-bar" id="${idPfx}-reuse" hidden></div>` : ''}
            ${selectable ? `<div class="pt-select-row" id="${idPfx}-sarow" style="display:none;">
                <input type="checkbox" class="pt-checkbox" id="${idPfx}-allcb">
                <span class="pt-info-chip" id="${idPfx}-cnt"></span>
                <span class="pt-info-chip" id="${idPfx}-oncnt" style="display:none;"></span>
                <span class="pt-selected-chip" style="display:none;"></span>
            </div>` : `<div class="pt-select-row" id="${idPfx}-sarow" style="display:none;">
                <span class="pt-info-chip" id="${idPfx}-cnt"></span>
                <span class="pt-info-chip" id="${idPfx}-oncnt" style="display:none;"></span>
            </div>`}
        </div>
        <div class="pt-page-scroll">
            <div class="pt-block-list" id="${idPfx}-list"></div>
            ${kind !== 'wi' ? ['rx', 'sc'].map(k => `<div class="pt-bundle" id="${idPfx}-${k}" hidden>
                <div class="pt-bundle-head" role="button" tabindex="0"><span class="pt-block-chevron">▶</span><span class="pt-bundle-title"></span></div>
                <div class="pt-bundle-body" hidden>
                    <label class="pt-bundle-all"><input type="checkbox" class="pt-checkbox"> 이 섹션 전체 선택</label>
                    <div class="pt-bundle-list"></div>
                </div>
            </div>`).join('') : ''}
            <div class="pt-empty" id="${idPfx}-empty">
                <div class="pt-empty-icon">${icon}</div>
                <p id="${idPfx}-emptymsg">${hint}</p>
            </div>
        </div>`;

    const sel=page.querySelector(`#${idPfx}-sel`), list=page.querySelector(`#${idPfx}-list`);
    attachPicker(sel, { preset: '프리셋 고르기', wi: '월드인포 고르기', char: '캐릭터 고르기' }[kind] || '고르기', kind);
    // Bundled regex (rx) and JS Runner scripts (sc): two folded sections under the list
    const bundleSecs = ['rx', 'sc'].map(k => page.querySelector(`#${idPfx}-${k}`)).filter(Boolean);
    const bundleEls = (sel = '.pt-block-item') => bundleSecs.flatMap(sec => [...sec.querySelectorAll(`.pt-bundle-list ${sel}`)]);
    let bundleItems = [];
    const ctrl=page.querySelector(`#${idPfx}-ctrl`), saRow=page.querySelector(`#${idPfx}-sarow`);
    const pWrap=page.querySelector(`#${idPfx}-prog`), pBar=page.querySelector(`#${idPfx}-pbar`), pLabel=page.querySelector(`#${idPfx}-plbl`);
    const empty=page.querySelector(`#${idPfx}-empty`), emptyP=page.querySelector(`#${idPfx}-emptymsg`);
    const btnStop=page.querySelector(`#${idPfx}-stop`), searchEl=page.querySelector(`#${idPfx}-search`);
    const eyeBtn = page.querySelector(`#${idPfx}-eye`);
    // 📥 원본 보존: the preset that was loaded, as saved in ST
    page.querySelector(`#${idPfx}-orig`)?.addEventListener('click', async (ev) => {
        if (!loadedVal || loadedNoPick) {
            if (typeof toastr !== 'undefined') toastr.info('프리셋을 이름으로 골라 불러온 뒤 눌러 주세요');
            return;
        }
        const b = ev.currentTarget;
        b.disabled = true;
        try { await preserveOriginal(loadedVal); } finally { b.disabled = false; }
    });

    // ── 👀 Toggle title language (display-only, does not modify cache) ──
    // When ON: each block's name shows the translated title (if available).
    // When OFF (default): each block's name shows the original.
    // - data-orig-name attribute is saved on first toggle so we can always restore.
    // - Translated title comes from getTranslatedTitle(ns, id) which reads
    //   the first markdown heading line of the cached translation. If a
    //   translation has no heading, the original name is shown.
    // - Re-translation updates the cache; the next applyEyeMode call will pick
    //   up the new translated title automatically (we always re-read from cache).
    // What a row is found by in the search box: its name and text, its
    // translation and its translated name, straight from the cache. Rebuilt
    // whenever the names are repainted (after loading, translating, clearing),
    // so the search always agrees with what the row shows.
    const rowSearchText = b => [b.name, b.content, getCached(ns, b.id) || '', getTranslatedTitle(ns, b.id, b.name) || ''].join(' ').toLowerCase();
    let _eyeOn = false;
    const applyEyeMode = () => {
        const byId = new Map(items.map(b => [String(b.id), b]));
        [...list.querySelectorAll('.pt-block-item'), ...bundleEls()].forEach(item => {
            const id = item.dataset.id;
            if (!id) return;
            const block = byId.get(id);
            if (block) item.dataset.searchText = rowSearchText(block);
            const nameEl = item.querySelector('.pt-block-name');
            if (!nameEl) return;
            // Save original on first use
            if (!item.dataset.origName) {
                item.dataset.origName = nameEl.textContent || '';
            }
            if (_eyeOn) {
                const tTitle = getTranslatedTitle(ns, id, item.dataset.origName);
                nameEl.textContent = tTitle || item.dataset.origName;
            } else {
                nameEl.textContent = item.dataset.origName;
            }
            // title attribute (hover tooltip) intentionally left as the original
        });
    };
    eyeBtn?.addEventListener('click', () => {
        _eyeOn = !_eyeOn;
        eyeBtn.setAttribute('aria-pressed', _eyeOn ? 'true' : 'false');
        eyeBtn.classList.toggle('pt-eye-on', _eyeOn);
        applyEyeMode();
    });

    // ── Bundled regex / JS Runner scripts (preset and character tabs) ──
    // Two folded sections under the list. Their translations are for reading
    // in the panel only: never exported, never in the title script, never
    // counted as tokens. Their selection is separate from the toggles'
    // select-all; the top buttons work on whatever is selected anywhere.
    //   regex  — a title-only row (no body). Every translate button translates
    //            regex names in batches, exactly like 📛 on toggles.
    //   script — expands like a toggle: name + info (the ⓘ text in JS Runner).
    //            ✦ translates name + info one by one; 📛 names only, batched.
    const NO_TRANS = '<span class="pt-no-trans">번역 전</span>';
    const makeBundleItem = (b) => {
        const el = PDOC.createElement('div');
        el.className = 'pt-block-item pt-bundle-item' + (b.titleOnly ? ' pt-bundle-flat' : '');
        el.dataset.id = b.id;
        el.dataset.searchText = rowSearchText(b);
        const badge = `<span class="pt-status-badge ${b.enabled ? 'pt-status-on' : 'pt-status-off'}">${b.enabled ? 'ON' : 'OFF'}</span>`;
        el.innerHTML = b.titleOnly
            ? `<div class="pt-block-header"><input type="checkbox" class="pt-checkbox">${badge}<span class="pt-block-name" title="${esc(b.name)}">${esc(b.name)}</span></div>`
            : `<div class="pt-block-header"><input type="checkbox" class="pt-checkbox">${badge}<span class="pt-block-name" title="${esc(b.name)}">${esc(b.name)}</span><span class="pt-block-chevron">▶</span></div>
               <div class="pt-block-body">
                   <div class="pt-original-label">원문 (설명)</div><div class="pt-original-text">${b.content ? esc(b.content) : ''}</div>
                   ${b.content ? '' : '<div class="pt-block-meta">설명(info)이 없는 스크립트입니다</div>'}
                   <div class="pt-translated-label">번역</div>
                   <div class="pt-translated-text">${getCached(ns, b.id) ? esc(getCached(ns, b.id)) : NO_TRANS}</div>
               </div>`;
        if (!b.titleOnly) {
            el.querySelector('.pt-block-header').addEventListener('click', e => {
                if (e.target.classList.contains('pt-checkbox')) return;
                el.classList.toggle('expanded');
            });
        }
        el.querySelector('.pt-checkbox').addEventListener('change', ev => el.classList.toggle('selected', ev.target.checked));
        return el;
    };
    const bundleOpenBeforeSearch = new Map();   // section → open state before a search opened it
    const setBundleOpen = (sec, open) => {
        sec.querySelector('.pt-bundle-body').hidden = !open;
        sec.classList.toggle('open', open);
    };
    const loadBundles = (val) => {
        bundleItems = [];
        bundleOpenBeforeSearch.clear();
        bundleSecs.forEach(sec => { sec.hidden = true; sec.querySelector('.pt-bundle-list').innerHTML = ''; });
        if (!bundleSecs.length) return;
        let found;
        try { found = collectBundled(getAskSource(kind, val).extensions); }
        catch (e) { console.warn(`[${EXT}] bundled scripts read failed`, e); return; }
        const used = new Set();
        const uid = (pfx, raw, i) => {
            let id = `${pfx}:${raw && raw.id != null && String(raw.id) ? String(raw.id) : 'n' + i}`;
            if (used.has(id)) id = `${pfx}:n${i}`;
            used.add(id);
            return id;
        };
        const rx = found.regex.map((r, i) => ({ id: uid('regex', r.raw, i), bundle: 'regex', name: r.name, content: '', enabled: r.enabled, titleOnly: true }));
        const sc = found.scripts.map((x, i) => {
            const info = typeof x.raw?.info === 'string' ? x.raw.info : '';
            return { id: uid('script', x.raw, i), bundle: 'script', name: x.name, content: info, enabled: x.enabled };
        });
        bundleItems = rx.concat(sc);
        [[bundleSecs[0], rx, '동봉 정규식'], [bundleSecs[1], sc, '동봉 스크립트']].forEach(([sec, arr, label]) => {
            if (!sec || !arr.length) return;
            sec.querySelector('.pt-bundle-title').textContent = `${label} ${arr.length}`;
            const frag = PDOC.createDocumentFragment();
            arr.forEach(b => frag.appendChild(makeBundleItem(b)));
            sec.querySelector('.pt-bundle-list').appendChild(frag);
            sec.querySelector('.pt-bundle-all input').checked = false;
            setBundleOpen(sec, false);
            sec.hidden = false;
        });
        if (bundleItems.length) ensureBundleCss();
    };
    // Refresh the sections after a run: script translation boxes, search text
    const paintBundle = () => bundleItems.forEach(b => {
        const el = bundleEls(`.pt-block-item[data-id="${CSS.escape(b.id)}"]`)[0];
        if (!el) return;
        if (!b.titleOnly) {
            const box = el.querySelector('.pt-translated-text');
            const t = getCached(ns, b.id);
            if (box) { box.innerHTML = t ? esc(t) : NO_TRANS; delete box.dataset.origHtml; }
        }
        el.dataset.searchText = rowSearchText(b);
    });
    bundleSecs.forEach(sec => {
        const head = sec.querySelector('.pt-bundle-head');
        const toggle = () => setBundleOpen(sec, sec.querySelector('.pt-bundle-body').hidden);
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        sec.querySelector('.pt-bundle-all input').addEventListener('change', ev => {
            sec.querySelectorAll('.pt-bundle-list .pt-block-item').forEach(item => {
                if (item.style.display === 'none') return;
                const cb = item.querySelector('.pt-checkbox');
                cb.checked = ev.target.checked;
                item.classList.toggle('selected', ev.target.checked);
            });
        });
    });
    // What the top buttons act on: the selection anywhere, or — when nothing is
    // selected — every toggle (never the bundled sections).
    const pickTargets = () => {
        const selT = new Set([...list.querySelectorAll('.pt-block-item.selected')].map(e => e.dataset.id));
        const selB = new Set(bundleEls('.pt-block-item.selected').map(e => e.dataset.id));
        if (!selT.size && !selB.size) return items.slice();
        return [...items.filter(b => selT.has(String(b.id))), ...bundleItems.filter(b => selB.has(b.id))];
    };
    // After titles were translated: show them, like 📛 does
    const showTitles = () => {
        paintBundle();
        if (!_eyeOn && eyeBtn) eyeBtn.click();
        else applyEyeMode();
    };

    // ── Ask: one conversation per loaded item, kept in memory only ──
    // Loading another item and coming back resumes its conversation; a page
    // reload clears everything. The most recent ASK_KEEP items are kept.
    //   history: [{ q, a, refs, tag }]   failed: { q, err, tag } — unanswered, retryable
    //   pendingQ: question in flight     view: the open window showing this conversation
    const ASK_KEEP = 10;
    const asks = new Map();   // ns → conversation, least recently used first
    const askState = (key) => {
        let st = asks.get(key);
        if (st) { asks.delete(key); asks.set(key, st); return st; }
        st = { history: [], failed: null, scope: 'all', busy: false, abort: null, pendingQ: null, view: null };
        asks.set(key, st);
        for (const [k, v] of asks) { if (asks.size <= ASK_KEEP) break; if (!v.busy) asks.delete(k); }
        return st;
    };
    const kindWord = kind === 'preset' ? '프리셋' : (kind === 'wi' ? '월드인포' : '캐릭터카드');
    const askExample = kind === 'preset' ? '답변 분량을 조절하는 토글은 어디에 있나요?'
                     : kind === 'wi'     ? '장소와 관련된 설정은 어느 엔트리에 있나요?'
                     :                     '이 인물의 가족관계는 어떻게 되나요?';
    const askSelIds = () => new Set([...list.querySelectorAll('.pt-block-item.selected')].map(e => e.dataset.id).filter(Boolean));
    const askJump = (id) => {
        const el = list.querySelector(`.pt-block-item[data-id="${CSS.escape(id)}"]`);
        if (!el) { if (typeof toastr !== 'undefined') toastr.info('패널 목록에서 항목을 찾지 못했습니다'); return; }
        const reveal = () => {
            el.classList.add('expanded');
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.classList.add('pt-ask-flash');
            setTimeout(() => el.classList.remove('pt-ask-flash'), 1600);
        };
        if (el.style.display === 'none' && searchEl) {
            // Hidden by an active search — clear it so the item can be shown
            searchEl.value = '';
            searchEl.dispatchEvent(new Event('input'));
            setTimeout(reveal, 180);   // search is debounced by 120ms
        } else reveal();
    };
    const askOpen = () => {
        if (!items.length) { if (typeof toastr !== 'undefined') toastr.info('먼저 항목을 불러오세요'); return; }
        const ask = askState(ns);
        // Archive key: the item itself. A preset loaded with no selection is
        // stored under its real name rather than the placeholder.
        const archKey = (kind === 'preset' && ns.endsWith('::__cur__'))
            ? `pt-preset::${getCurrentPresetName() || '__cur__'}` : ns;
        const panelEl = PDOC.getElementById('pt-panel');
        if (!panelEl) return;
        ensureAskCss();
        panelEl.querySelector('.pt-ask-backdrop')?.remove();

        // What was loaded, not what the picker shows now (picking does not load)
        const src = getAskSource(kind, loadedVal);
        const bundles = kind === 'wi' ? { regex: [], scripts: [] } : collectBundled(src.extensions);
        const bookAll = Array.isArray(src.book) ? src.book : [];
        const bookOn  = bookAll.filter(e => e?.enabled !== false).length;
        const selCount = askSelIds().size;
        const ac = cfg();
        if (ask.scope === 'sel' && !selCount) ask.scope = 'all';

        const bd = PDOC.createElement('div');
        bd.className = 'pt-ask-backdrop';
        bd.innerHTML = `
          <div class="pt-ask-box" role="dialog" aria-modal="true">
            <div class="pt-ask-head">
              <span class="pt-ask-title"><i class="fa-solid fa-comment-dots"></i>&nbsp;${esc(src.label || kindWord)}</span>
              <button type="button" class="pt-ask-close" aria-label="닫기">✕</button>
            </div>
            <div class="pt-ask-opts">
              <label><input type="radio" name="pt-ask-scope-${kind}" value="all" ${ask.scope === 'all' ? 'checked' : ''}> 전체 ${items.length}개</label>
              <label class="${selCount ? '' : 'pt-ask-dis'}"><input type="radio" name="pt-ask-scope-${kind}" value="sel" ${ask.scope === 'sel' ? 'checked' : ''} ${selCount ? '' : 'disabled'}> 선택한 ${selCount}개</label>
              ${bundles.regex.length ? `<label>정규식 ${bundles.regex.length}개 <select class="pt-ask-regex"><option value="names">이름만</option><option value="full">내용까지</option><option value="off">제외</option></select></label>` : ''}
              ${bundles.scripts.length ? `<label><input type="checkbox" class="pt-ask-scripts" ${ac.askIncludeScripts ? 'checked' : ''}> 스크립트 ${bundles.scripts.length}개 포함</label>` : ''}
              ${bookAll.length ? `<label><input type="checkbox" class="pt-ask-book" ${ac.askIncludeBook ? 'checked' : ''}> 임베디드 월드북 ${bookAll.length}개 포함</label>
              <label class="pt-ask-book-on-wrap ${ac.askIncludeBook ? '' : 'pt-ask-dis'}"><input type="checkbox" class="pt-ask-book-on" ${ac.askBookEnabledOnly ? 'checked' : ''} ${ac.askIncludeBook ? '' : 'disabled'}> 켜진 엔트리만 (${bookOn}개)</label>` : ''}
              <button type="button" class="pt-ask-arch-btn" title="답변 보관함"><i class="fa-solid fa-bookmark"></i>&nbsp;보관함 <span class="pt-ask-arch-n"></span></button>
            </div>
            <div class="pt-ask-log"></div>
            <div class="pt-ask-arch" hidden></div>
            <div class="pt-ask-foot">
              <div class="pt-ask-est"></div>
              ${kind === 'preset' ? `<div class="pt-ask-faq">${ASK_FAQ_PRESET.map((f, i) => `<button type="button" data-faq="${i}">${esc(f[0])}</button>`).join('')}<button type="button" data-faq="sel" title="패널에서 선택한 토글에 대해 묻기">이건 뭔가요</button></div>` : ''}
              <textarea class="pt-ask-input" rows="2" placeholder="이 ${kindWord}에 대해 물어보세요"></textarea>
              <div class="pt-ask-actions">
                <button type="button" class="pt-ask-reset">새 대화</button>
                <button type="button" class="pt-ask-send">보내기</button>
              </div>
            </div>
          </div>`;
        panelEl.appendChild(bd);
        const q = s => bd.querySelector(s);
        const input = q('.pt-ask-input'), sendBtn = q('.pt-ask-send'), log = q('.pt-ask-log');

        const buildMat = () => {
            const c = cfg();
            return buildAskMaterial({
                kind, items,
                scopeIds: ask.scope === 'sel' ? askSelIds() : null,
                regexMode: c.askRegexMode, includeScripts: c.askIncludeScripts, bundles,
                book: src.book, includeBook: c.askIncludeBook, bookEnabledOnly: c.askBookEnabledOnly,
                sourceLabel: src.label || kindWord,
            });
        };
        let mat = buildMat();   // rebuilt only when options change, not per keystroke

        const refreshEst = () => {
            const model = modelName();
            const hist = ask.history.reduce((n, h) => n + estimateTokens(h.q) + estimateTokens(h.a), 0);
            const total = mat.est + hist + estimateTokens(input.value) + 400;
            let note = '';
            if (mat.overBudget) note = ' · 분량이 많아 크게 줄여 보냅니다. 항목을 선택해 범위를 좁혀 보세요';
            else if (mat.trimmed) note = ' · 분량 때문에 일부를 줄여 보냅니다';
            q('.pt-ask-est').textContent = `약 ${total.toLocaleString()} 토큰${model ? ' · ' + model : ''}${note}`;
        };
        const REGEN_BTN = (title) => `<button type="button" class="pt-ask-regen" title="${title}" aria-label="${title}"><i class="fa-solid fa-rotate-right"></i></button>`;
        const faqRow = q('.pt-ask-faq');
        const renderLog = () => {
            sendBtn.textContent = ask.busy ? '중단' : '보내기';
            input.disabled = ask.busy;
            faqRow?.querySelectorAll('button').forEach(x => { x.disabled = ask.busy; });
            if (!ask.history.length && !ask.busy && !ask.failed) {
                log.innerHTML = `<div class="pt-ask-empty">불러온 ${kindWord}의 내용을 근거로 답합니다.<br>답변 속 <b>#번호</b>를 누르면 그 항목으로 이동해요.<br><br>예) ${esc(askExample)}</div>`;
                return;
            }
            const qBubble = text => `<div class="pt-ask-msg q">${esc(text).replace(/\n/g, '<br>')}</div>`;
            const saved = new Set((askArchiveCache.get(archKey) || []).map(e => askArchiveSig(e.q, e.a)));
            const lastIdx = ask.history.length - 1;
            const qa = ask.history.map((h, i) => {
                const on = saved.has(askArchiveSig(h.q, h.a));
                const save = `<button type="button" class="pt-ask-save${on ? ' on' : ''}" data-i="${i}" title="${on ? '보관함에서 빼기' : '보관함에 저장'}" aria-label="${on ? '보관함에서 빼기' : '보관함에 저장'}"><i class="fa-${on ? 'solid' : 'regular'} fa-bookmark"></i></button>`;
                const regenBtn = (i === lastIdx && !ask.busy && !ask.failed) ? REGEN_BTN('답변 다시 받기') : '';
                return `${qBubble(h.q)}<div class="pt-ask-msg a">${renderAskAnswer(h.a, h.refs)}</div><div class="pt-ask-acts">${save}${regenBtn}</div>`;
            }).join('');
            let tail = '';
            if (ask.busy) tail = `${qBubble(ask.pendingQ || '')}<div class="pt-ask-msg wait">답변을 기다리는 중…</div>`;
            else if (ask.failed) tail = `${qBubble(ask.failed.q)}<div class="pt-ask-msg err">${esc(ask.failed.err)}</div><div class="pt-ask-acts">${REGEN_BTN('다시 보내기')}</div>`;
            log.innerHTML = qa + tail;
            log.scrollTop = log.scrollHeight;
        };
        // A request may outlive this window (closed, then reopened), so results
        // are painted into whichever window currently shows this conversation.
        ask.view = { bd, log, input, render: renderLog, est: () => refreshEst() };
        const liveView = () => (ask.view && ask.view.bd.isConnected ? ask.view : null);

        const close = () => bd.remove();   // the conversation stays in memory

        // ── Answer archive view ──
        const arch = q('.pt-ask-arch'), archBtn = q('.pt-ask-arch-btn'), foot = q('.pt-ask-foot');
        const archList = () => askArchiveCache.get(archKey) || [];
        const archCount = () => { q('.pt-ask-arch-n').textContent = archList().length ? String(archList().length) : ''; };
        const fmtDate = t => { try { const d = new Date(t); return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`; } catch (e) { return ''; } };
        const renderArch = () => {
            const list = archList();
            const cards = list.map(e => `
              <div class="pt-ask-card" data-id="${esc(e.id)}">
                <div class="pt-ask-card-head">
                  <div class="pt-ask-card-q">${e.tag ? `<span class="pt-ask-card-tag">${esc(e.tag)}</span>` : esc(e.q)}</div>
                  <div class="pt-ask-card-prev">${esc(askPlain(e.a))}</div>
                </div>
                <div class="pt-ask-card-body" hidden></div>
              </div>`).join('');
            arch.innerHTML = `
              <div class="pt-ask-arch-bar">
                <button type="button" class="pt-ask-arch-back">← 대화</button>
                <span class="pt-ask-arch-title">보관함 ${list.length}개</span>
                <button type="button" class="pt-ask-arch-clear" ${list.length ? '' : 'disabled'}>비우기</button>
              </div>
              ${cards || '<div class="pt-ask-empty">저장한 답변이 없어요.<br>답변 아래 <i class="fa-regular fa-bookmark"></i> 를 누르면 여기에 모입니다.</div>'}`;
        };
        const showArch = (on) => {
            arch.hidden = !on; log.hidden = on; foot.hidden = on;
            archBtn.classList.toggle('on', on);
            if (on) renderArch(); else renderLog();
        };
        archBtn.addEventListener('click', () => showArch(arch.hidden));
        const toggleSave = async (i) => {
            const h = ask.history[i];
            if (!h) return;
            const sig = askArchiveSig(h.q, h.a);
            let outcome = null;   // 'saved' | 'removed' | 'full'
            try {
                await askArchiveUpdate(archKey, list => {
                    const exists = list.some(e => askArchiveSig(e.q, e.a) === sig);
                    if (!exists && list.length >= ASK_ARCHIVE_MAX) { outcome = 'full'; return null; }
                    outcome = exists ? 'removed' : 'saved';
                    return exists
                        ? list.filter(e => askArchiveSig(e.q, e.a) !== sig)
                        : [{ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), savedAt: Date.now(), q: h.q, a: h.a, tag: h.tag || null, refs: [...(h.refs || new Map())] }].concat(list);
                });
                if (typeof toastr !== 'undefined') {
                    if (outcome === 'full') toastr.warning(`보관함이 가득 찼어요 (${ASK_ARCHIVE_MAX}개)`);
                    else toastr.success(outcome === 'removed' ? '보관함에서 뺐어요' : '보관함에 저장했어요');
                }
            } catch (e) {
                console.error(`[${EXT}] answer archive write failed`, e);
                if (typeof toastr !== 'undefined') toastr.error('보관함 저장에 실패했습니다');
            }
            archCount();
            liveView()?.render();
        };
        arch.addEventListener('click', async e => {
            if (e.target.closest('.pt-ask-arch-back')) { showArch(false); return; }
            if (e.target.closest('.pt-ask-arch-clear')) {
                if (!archList().length || !confirm(`보관함의 답변 ${archList().length}개를 모두 지울까요?`)) return;
                try { await askArchiveUpdate(archKey, () => []); } catch (err) { if (typeof toastr !== 'undefined') toastr.error('비우기에 실패했습니다'); }
                archCount(); renderArch(); return;
            }
            const card = e.target.closest('.pt-ask-card');
            if (!card) return;
            const entry = archList().find(x => x.id === card.dataset.id);
            if (!entry) return;
            if (e.target.closest('.pt-ask-card-del')) {
                if (!confirm('이 답변을 보관함에서 지울까요?')) return;
                try { await askArchiveUpdate(archKey, list => list.filter(x => x.id !== entry.id)); } catch (err) { if (typeof toastr !== 'undefined') toastr.error('지우기에 실패했습니다'); }
                archCount(); renderArch(); return;
            }
            const chip = e.target.closest('.pt-ask-ref[data-ref]');
            if (chip) { if (chip.dataset.id) { close(); askJump(chip.dataset.id); } return; }
            if (!e.target.closest('.pt-ask-card-head')) return;
            // Expand / collapse; the full answer is rendered on first open
            const body = card.querySelector('.pt-ask-card-body');
            const open = body.hidden;
            if (open && !body.dataset.filled) {
                body.innerHTML = `${entry.tag ? `<div class="pt-ask-card-full-q">${esc(entry.q)}</div>` : ''}<div class="pt-ask-card-ans">${renderAskAnswer(entry.a, new Map(entry.refs || []))}</div>
                  <div class="pt-ask-card-foot"><span>${fmtDate(entry.savedAt)}</span><button type="button" class="pt-ask-card-del" title="이 답변 지우기" aria-label="이 답변 지우기"><i class="fa-solid fa-trash-can"></i></button></div>`;
                body.dataset.filled = '1';
            }
            body.hidden = !open;
            card.classList.toggle('open', open);
        });
        askArchiveLoad(archKey).then(() => { archCount(); if (bd.isConnected && !log.hidden) renderLog(); });
        // One request. regen: replace the last answer; the old one comes back if
        // the new request fails or is stopped. tag: the ready-made question's label.
        const request = async (question, regen, tag) => {
            const prev = regen ? ask.history.pop() : null;
            if (prev) tag = prev.tag;
            ask.failed = null;
            const role = modelTurn();
            const qs = ask.history.map(h => h.q).concat([question]);
            const messages = [{ role: 'user', content: `${askInstructions(kind, effLang())}\n\n${mat.text}\n\n=== QUESTION ===\n${qs[0]}` }];
            ask.history.forEach((h, i) => {
                messages.push({ role, content: h.a });
                messages.push({ role: 'user', content: qs[i + 1] });
            });
            const usedRefs = mat.refs;
            ask.busy = true;
            ask.pendingQ = question;
            ask.abort = new AbortController();
            liveView()?.render();
            let notice = '';
            try {
                const a = await askChatCompletion(messages, ask.abort.signal);
                ask.history.push({ q: question, a, refs: usedRefs, tag: tag || null });
                const v = liveView();
                if (v && v.input.value.trim() === question) v.input.value = '';
            } catch (e) {
                const msg = e?.name === 'AbortError' ? '중단했습니다' : `오류: ${e?.message || e}`;
                if (prev) {
                    ask.history.push(prev);
                    notice = `${e?.name === 'AbortError' ? '다시 받기를 중단했습니다' : `다시 받기 실패 — ${msg}`}. 이전 답변을 그대로 두었습니다.`;
                } else {
                    ask.failed = { q: question, err: msg, tag: tag || null };
                }
            } finally {
                ask.busy = false;
                ask.pendingQ = null;
                ask.abort = null;
                const v = liveView();
                if (v) {
                    v.render();
                    if (notice) {
                        v.log.insertAdjacentHTML('beforeend', `<div class="pt-ask-msg err">${esc(notice)}</div>`);
                        v.log.scrollTop = v.log.scrollHeight;
                    }
                    v.est();
                }
            }
        };
        const send = () => {
            if (ask.busy) { ask.abort?.abort(); return; }
            const question = input.value.trim();
            if (question) request(question, false, null);
        };
        const regen = () => {
            if (ask.busy) return;
            if (ask.failed) { request(ask.failed.q, false, ask.failed.tag); return; }   // retry the failed question
            const last = ask.history[ask.history.length - 1];
            if (last) request(last.q, true);
        };
        // Ready-made questions: sent right away, without touching the input box
        faqRow?.addEventListener('click', e => {
            const btn = e.target.closest('button[data-faq]');
            if (!btn || ask.busy) return;
            if (btn.dataset.faq !== 'sel') {
                const f = ASK_FAQ_PRESET[+btn.dataset.faq];
                if (f) request(f[1], false, f[0]);
                return;
            }
            const ids = [...askSelIds()];
            if (!ids.length) { if (typeof toastr !== 'undefined') toastr.info('패널에서 궁금한 토글을 먼저 선택하세요'); return; }
            if (ids.length > ASK_FAQ_SELECTED_MAX) { if (typeof toastr !== 'undefined') toastr.info(`한 번에 ${ASK_FAQ_SELECTED_MAX}개까지 물어볼 수 있어요`); return; }
            const labels = ids.map(id => {
                const n = items.findIndex(b => String(b.id) === id) + 1;
                return n ? `#${n} ${items[n - 1].name}` : null;
            }).filter(Boolean);
            if (!labels.length) return;
            request(`선택한 토글(${labels.join(', ')})은 각각 어떤 역할을 하나요? 켜고 끄면 무엇이 달라지나요?`, false, '이건 뭔가요');
        });

        q('.pt-ask-close').addEventListener('click', close);
        bd.addEventListener('click', e => { if (e.target === bd) close(); });
        sendBtn.addEventListener('click', send);
        input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
        let estTimer = null;
        input.addEventListener('input', () => { clearTimeout(estTimer); estTimer = setTimeout(refreshEst, 300); });
        bd.querySelectorAll(`input[name="pt-ask-scope-${kind}"]`).forEach(r => r.addEventListener('change', () => {
            ask.scope = r.value; mat = buildMat(); refreshEst();
        }));
        // Material options are remembered in settings for next time
        const setOpt = (key, val) => { cfg()[key] = val; saveSettingsDebounced(); mat = buildMat(); refreshEst(); };
        const regexSel = q('.pt-ask-regex');
        if (regexSel) {
            regexSel.value = cfg().askRegexMode;
            regexSel.addEventListener('change', () => setOpt('askRegexMode', regexSel.value));
        }
        q('.pt-ask-scripts')?.addEventListener('change', e => setOpt('askIncludeScripts', e.target.checked));
        q('.pt-ask-book')?.addEventListener('change', e => {
            const on = e.target.checked;
            const sub = q('.pt-ask-book-on');
            if (sub) sub.disabled = !on;
            q('.pt-ask-book-on-wrap')?.classList.toggle('pt-ask-dis', !on);
            setOpt('askIncludeBook', on);
        });
        q('.pt-ask-book-on')?.addEventListener('change', e => setOpt('askBookEnabledOnly', e.target.checked));
        q('.pt-ask-reset').addEventListener('click', () => {
            if (ask.busy) return;
            if (ask.history.length && !confirm('지금까지의 질문과 답변을 지우고 새로 시작할까요?')) return;
            ask.history = []; ask.failed = null; renderLog(); refreshEst();
        });
        log.addEventListener('click', e => {
            if (e.target.closest('.pt-ask-regen')) { regen(); return; }
            const sv = e.target.closest('.pt-ask-save');
            if (sv) { toggleSave(+sv.dataset.i); return; }
            const chip = e.target.closest('.pt-ask-ref[data-ref]');
            if (!chip) return;
            // Jump by the id stored with the answer: the list may have changed
            // since (another load), so the #number alone is not reliable.
            const id = chip.dataset.id;
            if (!id) return;
            close();
            askJump(id);
        });

        renderLog();
        refreshEst();
    };
    ASK_CONTROLLERS[kind] = { open: askOpen };

    const showEmpty = msg => { empty.style.display=''; if(msg)emptyP.textContent=msg; ctrl.style.display='none'; if(saRow)saRow.style.display='none'; };
    const hideEmpty = () => { empty.style.display='none'; ctrl.style.display=''; if(saRow)saRow.style.display=''; };
    showEmpty(hint);

    // Refills (including the delayed ones on the character tab) keep the
    // current pick; with nothing picked, the character tab takes the chat's.
    const refillSelect = async () => {
        const opts=isAsync?await listFn():listFn();
        const keep = sel.value || (kind === 'char' ? currentCharAvatar() : '');
        sel.innerHTML='<option value="">— 선택 —</option>';
        opts.forEach(item=>{ const o=PDOC.createElement('option'); o.value=item.id; o.textContent=item.name; sel.appendChild(o); });
        if (keep && opts.some(it => String(it.id) === keep)) setSelValue(sel, keep);
    };
    refillSelect();
    if (idPfx==='pt-char') {
        try { eventSource?.on?.(event_types?.APP_READY, refillSelect); } catch(e){}
        setTimeout(refillSelect,1500); setTimeout(refillSelect,4000);
    }

    // Count chips: total, and the total of items that are switched on (presets
    // and world info only — character fields have no on/off).
    const showCounts = (loaded) => {
        const tk = b => b._tok ?? estimateTokens(tokenTextOf(b));
        const total = loaded.reduce((n, b) => n + tk(b), 0);
        const cntEl = page.querySelector(`#${idPfx}-cnt`);
        if (cntEl) cntEl.textContent = `📊 ${loaded.length}개 · ${total.toLocaleString()} tkn`;
        const onEl = page.querySelector(`#${idPfx}-oncnt`);
        if (!onEl) return;
        if (kind === 'char') { onEl.style.display = 'none'; return; }
        const on = loaded.filter(b => b.enabled !== false).reduce((n, b) => n + tk(b), 0);
        onEl.textContent = `ON ${on.toLocaleString()} tkn`;
        onEl.title = kind === 'wi' ? '켜진 엔트리의 합계 (실제 발동 여부와는 다를 수 있음)' : '켜진 토글의 합계';
        onEl.style.display = '';
    };

    // Background token refinement. A newer load bumps tokGen, which cancels an
    // older pass so it never writes counts into a list it no longer owns.
    let tokGen = 0;
    const refineTokenCounts = async (gen, loaded) => {
        let changed = false;
        for (let k = 0; k < loaded.length; k++) {
            if (gen !== tokGen) return;
            const b = loaded[k];
            const n = await countTokensAccurate(tokenTextOf(b));
            if (gen !== tokGen) return;
            if (typeof n !== 'number' || !isFinite(n)) continue;
            b._tok = n;
            const tkEl = list.querySelector(`.pt-block-item[data-id="${CSS.escape(String(b.id))}"] .pt-token-count`);
            if (tkEl && tkEl.textContent !== String(n)) { tkEl.textContent = String(n); changed = true; }
            // Yield now and then so a long list never monopolises the main thread
            if (k % 25 === 24) await new Promise(r => setTimeout(r, 0));
        }
        if (gen !== tokGen || !changed) return;
        showCounts(loaded);
        updateSelectedCount(page);
    };

    // Offer translations of identical toggles found in other presets (preset tab)
    const reuseBar = page.querySelector(`#${idPfx}-reuse`);
    let reuseOffer = null;   // { ns, lang, picks } for the list currently shown
    const offerReuse = (targetNs, targetName) => {
        if (!reuseBar) return;
        reuseOffer = null; reuseBar.hidden = true;
        let found;
        try { found = findReusableTranslations(targetNs, targetName, items); }
        catch (e) { console.warn(`[${EXT}] reuse lookup failed`, e); return; }
        if (!found.picks.length) return;
        ensureReuseCss();
        const whatOf = list => {
            const nFull = list.filter(p => p.kind === 'full').length, nTitle = list.length - nFull;
            return [nFull && `번역 ${nFull}개`, nTitle && `제목 ${nTitle}개`].filter(Boolean).join(' · ');
        };
        // One kind per bar, so the button never applies an unverified old
        // translation together with matching ones. Matches come first; old
        // "no selection" translations are offered on a later load, once
        // nothing matching is left.
        const same = found.picks.filter(p => !p.legacy);
        const picks = same.length ? same : found.picks;
        let msg;
        if (same.length) {
            const from = esc(found.sources[0]) + (found.sources.length > 1 ? ` 외 ${found.sources.length - 1}개` : '');
            msg = `🔁 같은 원문의 ${whatOf(same)}를 <b>${from}</b>에서 찾았어요`;
        } else msg = `🔁 예전에 '— 선택 —'으로 불러와 저장된 ${whatOf(picks)}가 있어요 <small>(어느 프리셋 것인지는 확인할 수 없어요. 이 프리셋 것이 맞을 때만 가져오세요)</small>`;
        // lang: the translations found are in this language; they are saved
        // only if it is still the target language when the button is pressed
        reuseOffer = { ns: targetNs, lang: effLang(), picks };
        reuseBar.innerHTML = `<span class="pt-reuse-msg">${msg}</span>`
            + `<button type="button" class="pt-reuse-take">가져오기</button><button type="button" class="pt-reuse-x" aria-label="닫기">✕</button>`;
        reuseBar.hidden = false;
    };
    reuseBar?.addEventListener('click', e => {
        if (e.target.closest('.pt-reuse-x')) { reuseBar.hidden = true; reuseOffer = null; return; }
        if (!e.target.closest('.pt-reuse-take') || !reuseOffer) return;
        if (reuseOffer.ns !== ns) { reuseBar.hidden = true; reuseOffer = null; return; }   // list changed meanwhile
        if (reuseOffer.lang !== effLang()) {   // target language changed meanwhile: saving would file them under the new one
            reuseBar.hidden = true; reuseOffer = null;
            if (typeof toastr !== 'undefined') toastr.info('번역 언어가 바뀌어 가져오지 않았어요. 다시 불러오면 새 언어로 찾아 드려요');
            return;
        }
        let n = 0;
        for (const p of reuseOffer.picks) {
            if (p.kind === 'full') {
                if (getCached(ns, p.id)) continue;
                setCache(ns, p.id, p.text);
                setBlockHTML(list, p.id, esc(p.text));
            } else {
                if (getTranslatedTitle(ns, p.id)) continue;
                setCacheTitle(ns, p.id, p.text);
            }
            n++;
        }
        reuseBar.hidden = true; reuseOffer = null;
        applyEyeMode();
        if (typeof toastr !== 'undefined') toastr.success(`번역 ${n}개를 가져왔어요`);
    });

    // Each 📂 로드 gets a number. Loads can overlap (world info and characters
    // are read asynchronously); only the newest one may set what the page
    // holds, and the list, namespace and loaded value are switched together
    // once its data is in, so they always describe the same item.
    let loadGen = 0;
    page.querySelector(`#${idPfx}-load`).addEventListener('click', async () => {
        const gen = ++loadGen;
        const picked = sel.value;
        // "— 선택 —" on the preset tab loads the preset that is current in ST.
        // It is named here, at load time, so its translations, Ask and export
        // stay with that preset even if ST switches to another one later (the
        // shared "__cur__" slot used to mix different presets).
        const val = (kind === 'preset' && !picked) ? (getCurrentPresetName() || '') : picked;
        if (reuseBar) { reuseBar.hidden = true; reuseOffer = null; }
        bundleSecs.forEach(sec => { sec.hidden = true; sec.querySelector('.pt-bundle-list').innerHTML = ''; });
        bundleItems = [];
        // Character tab: require explicit selection (no implicit "current character" fallback)
        if (kind === 'char' && !val) {
            showEmpty('불러올 데이터가 없습니다.');
            return;
        }
        showEmpty('로딩 중...');
        const got = await loadFn(val);
        if (gen !== loadGen) return;                      // a newer load took over
        ns = `${idPfx}::${val||'__cur__'}`;
        items = got;
        loadedVal = val;
        loadedNoPick = !picked;
        list.innerHTML='';
        if (picked && items.length) recentPush(kind, picked);   // the picker lists it under 최근

        // 선택 상태 완전 초기화 (프리셋 변경 시 이전 선택이 남지 않도록)
        const allCb = page.querySelector(`#${idPfx}-allcb`);
        if (allCb) allCb.checked = false;
        const selChip = page.querySelector('.pt-selected-chip');
        if (selChip) { selChip.style.display = 'none'; selChip.textContent = ''; }

        if (!items.length) { showEmpty('불러올 데이터가 없습니다.'); return; }
        hideEmpty();
        loadBundles(val);
        const tokGenAtLoad = ++tokGen;
        showCounts(items);
        const myItems = items, myNs = ns;
        let i=0;
        const renderChunk=()=>{
            if (gen !== loadGen) return;                  // a newer load is drawing the list
            const end=Math.min(i+50,myItems.length), frag=PDOC.createDocumentFragment();
            for(;i<end;i++) frag.appendChild(makeBlockItem(myItems[i],myNs,selectable));
            list.appendChild(frag);
            if(i<myItems.length) requestAnimationFrame(renderChunk);
            else {
                if(searchEl)searchEl.value='';
                updateSelectedCount(page);
                // Re-apply eye-mode to freshly rendered items if currently ON
                applyEyeMode();
                // Replace estimates with real counts in the background
                refineTokenCounts(tokGenAtLoad, myItems);
                if (kind === 'preset') offerReuse(myNs, val);
            }
        };
        renderChunk();
    });

    // Search with highlight
    let searchTimeout = null;
    searchEl?.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            const q=searchEl.value.trim().toLowerCase();
            [...list.querySelectorAll('.pt-block-item'), ...bundleEls()].forEach(el=>{
                if (!q) {
                    el.style.display='';
                    // 하이라이트 제거
                    el.querySelectorAll('.pt-original-text,.pt-translated-text').forEach(box=>{
                        if (box.dataset.origHtml) { box.innerHTML=box.dataset.origHtml; delete box.dataset.origHtml; }
                    });
                } else {
                    const match=el.dataset.searchText.includes(q);
                    el.style.display=match?'':'none';
                    if (match) {
                        // 하이라이트 적용
                        el.querySelectorAll('.pt-original-text,.pt-translated-text').forEach(box=>{
                            if (!box.dataset.origHtml) box.dataset.origHtml=box.innerHTML;
                            box.innerHTML=highlightText(box.dataset.origHtml, q);
                        });
                    }
                }
            });
            // A bundled section opens while it holds matches, then returns to how it was
            bundleSecs.forEach(sec => {
                if (sec.hidden) return;
                const hits = q && [...sec.querySelectorAll('.pt-bundle-list .pt-block-item')].some(el => el.style.display !== 'none');
                if (hits) {
                    if (!bundleOpenBeforeSearch.has(sec)) bundleOpenBeforeSearch.set(sec, !sec.querySelector('.pt-bundle-body').hidden);
                    setBundleOpen(sec, true);
                } else if (bundleOpenBeforeSearch.has(sec)) {
                    setBundleOpen(sec, bundleOpenBeforeSearch.get(sec));
                    bundleOpenBeforeSearch.delete(sec);
                }
            });
        }, 120);
    });

    page.querySelector(`#${idPfx}-allcb`)?.addEventListener('change', ev => {
        list.querySelectorAll('.pt-block-item').forEach(item=>{
            if (item.style.display==='none') return;
            const cb=item.querySelector('.pt-checkbox');
            if (cb) { cb.checked=ev.target.checked; item.classList.toggle('selected',ev.target.checked); }
        });
        updateSelectedCount(page);
    });

    // isShown: results are painted only while this page still shows the item the run started on
    const mkArgs=force=>{ const runNs = ns; return {items,list:page,ns,pBar,pLabel,pWrap,btnStop,forceRetranslate:!!force,kind,targets:pickTargets(),onTitles:showTitles,onDone:()=>{paintBundle();applyEyeMode();},isShown:()=>ns===runNs}; };
    page.querySelector(`#${idPfx}-trans`).addEventListener('click',async()=>{await runTranslation(mkArgs(false));});
    page.querySelector(`#${idPfx}-retr`).addEventListener('click',async()=>{if(!confirm('재번역?')) return; await runTranslation(mkArgs(true));});
    page.querySelector(`#${idPfx}-titles`)?.addEventListener('click',async()=>{
        await runTitleTranslation({
            items, list: page, ns, pBar, pLabel, pWrap, btnStop, kind, targets: pickTargets(),
            onDone: showTitles,   // show the freshly translated titles right away
        });
    });
    btnStop?.addEventListener('click',()=>{stopReq=true;});
    page.querySelector(`#${idPfx}-clr`).addEventListener('click',()=>{
        // Respect selection (toggles and the bundled section); otherwise clear all toggles
        const selectedIds = [...list.querySelectorAll('.pt-block-item.selected'), ...bundleEls('.pt-block-item.selected')].map(el=>el.dataset.id).filter(Boolean);
        const targetIds = selectedIds.length ? selectedIds : items.map(i=>i.id);
        const scope = selectedIds.length ? `선택한 ${selectedIds.length}개 항목` : `로드된 전체 ${items.length}개 항목`;
        if(!confirm(`${scope}의 번역 캐시를 비울까요?`)) return;
        clearNS(ns, targetIds);
        // Update UI: reset translated text only for cleared items
        const targetSet = new Set(targetIds);
        page.querySelectorAll('.pt-block-item').forEach(el => {
            if (!targetSet.has(el.dataset.id)) return;
            const trEl = el.querySelector('.pt-translated-text');
            if (trEl) {
                trEl.innerHTML = '<span class="pt-no-trans">번역 전</span>';
                delete trEl.dataset.origHtml;   // same stale-snapshot issue as setBlockHTML
            }
        });
        paintBundle();
        applyEyeMode();   // names shown in 👀 mode fall back to the original
    });

    // ── Export: Copy ──────────────────────────────────────────────────
    page.querySelector(`#${idPfx}-copy`)?.addEventListener('click', async () => {
        if (!items.length) { if (typeof toastr!=='undefined') toastr.warning('로드된 데이터가 없습니다'); return; }
        const checkedCount = page.querySelectorAll('.pt-block-list .pt-block-item.selected').length;
        if (checkedCount === 0) {
            if (typeof toastr!=='undefined') toastr.warning('복사할 항목을 먼저 선택해주세요');
            return;
        }
        const targets = collectTargetItems(page, items, idPfx, ns);
        const choice = await askTextChoice('어떤 내용을 복사할까요?');
        if (!choice) return;
        const text = formatItemsAsText(targets, choice);
        const ok = await copyTextToClipboard(text);
        if (typeof toastr!=='undefined') {
            ok ? toastr.success(`${targets.length}개 항목 복사됨`) : toastr.error('복사 실패');
        }
    });

    // ── Export: TXT ───────────────────────────────────────────────────
    page.querySelector(`#${idPfx}-txt`)?.addEventListener('click', async () => {
        if (!items.length) { if (typeof toastr!=='undefined') toastr.warning('로드된 데이터가 없습니다'); return; }
        const checkedCount = page.querySelectorAll('.pt-block-list .pt-block-item.selected').length;
        if (checkedCount === 0) {
            if (typeof toastr!=='undefined') toastr.warning('내보낼 항목을 먼저 선택해주세요');
            return;
        }
        const targets = collectTargetItems(page, items, idPfx, ns);
        const choice = await askTextChoice('어떤 내용을 내보낼까요?');
        if (!choice) return;
        const text = formatItemsAsText(targets, choice);
        const srcName = getSourceName(kind, page, idPfx, loadedVal);
        const suffix = choice === 'original' ? 'original' : (choice === 'translated' ? effLang() : `${effLang()}_bilingual`);
        const filename = `${sanitizeFilename(srcName)}_${suffix}.txt`;
        downloadBlob(new Blob([text], {type:'text/plain;charset=utf-8'}), filename);
        if (typeof toastr!=='undefined') toastr.success(`${filename} 다운로드됨`);
    });

    // ── Export: JSON ──────────────────────────────────────────────────
    page.querySelector(`#${idPfx}-json`)?.addEventListener('click', async () => {
        if (!items.length) { if (typeof toastr!=='undefined') toastr.warning('로드된 데이터가 없습니다'); return; }
        try {
            // The loaded item: the picker may already show another one (picking does not load)
            const srcVal = loadedVal || '';

            // Build set of selected item ids (for partial export in WI/char)
            const checkedIds = new Set(
                Array.from(page.querySelectorAll('.pt-block-list .pt-block-item.selected'))
                    .map(el => el.dataset.id)
                    .filter(Boolean)
            );

            let result;
            if (kind === 'preset' || kind === 'wi') {
                const mode = await askChoice('어떤 형식으로 내보낼까요?', [
                    { v: 'data',   label: kind === 'wi' ? 'ST 월드인포 JSON' : 'ST 프리셋 JSON' },
                    { v: 'script', label: 'JS Runner 제목 번역 스크립트' },
                ]);
                if (!mode) return;
                if (mode === 'script') {
                    const r = exportTitleScript(kind, srcVal, items, ns);
                    const blob = new Blob([JSON.stringify(r.data, null, 2)], {type:'application/json;charset=utf-8'});
                    downloadBlob(blob, r.filename);
                    if (typeof toastr!=='undefined') {
                        const skipMsg = r.skipped ? `, 미번역 ${r.skipped}개 제외` : '';
                        toastr.success(`${r.filename} 다운로드됨 (제목 ${r.count}개${skipMsg})`);
                    }
                    return;
                }
            }
            if (kind === 'preset') {
                // Preset: always full export (structure integrity)
                result = exportPresetJSON(srcVal);
            } else if (kind === 'wi') {
                // WI: partial selection supported
                result = await exportWorldInfoJSON(srcVal, checkedIds);
            } else if (kind === 'char') {
                // Character: partial field selection supported
                const includeCB = confirm('캐릭터 카드에 임베디드 월드북(character_book)이 포함되어 있는 경우, JSON에 함께 포함할까요?\n\n[확인] = 포함 (원문 그대로)\n[취소] = 제외\n\n※ 임베디드 월드북의 내용은 번역되지 않고 원문 그대로 저장됩니다.');
                result = await exportCharacterJSON(srcVal, { includeCharacterBook: includeCB }, checkedIds);
            }
            if (!result) return;
            const blob = new Blob([JSON.stringify(result.data, null, 2)], {type:'application/json;charset=utf-8'});
            downloadBlob(blob, result.filename);
            if (typeof toastr!=='undefined') {
                let scopeMsg = '';
                if (kind === 'wi' && checkedIds.size > 0) scopeMsg = ` (선택한 ${checkedIds.size}개 엔트리)`;
                else if (kind === 'char' && checkedIds.size > 0) scopeMsg = ` (선택한 ${checkedIds.size}개 필드)`;
                toastr.success(`${result.filename} 다운로드됨${scopeMsg}`);
            }
        } catch (err) {
            console.error(`[${EXT}] JSON export failed`, err);
            if (typeof toastr!=='undefined') toastr.error('JSON 내보내기 실패: ' + (err?.message || err));
        }
    });
}

// Collect items: selected ones if any, else all
function collectTargetItems(page, items, idPfx, ns) {
    const checked = Array.from(page.querySelectorAll('.pt-block-list .pt-block-item.selected'))
        .map(el => el.dataset.id)
        .filter(Boolean);
    const sourceList = checked.length > 0
        ? items.filter(i => checked.includes(String(i.id)))
        : items;
    // Attach _ns to each item for formatter
    return sourceList.map(i => ({ ...i, _ns: ns }));
}

// Name of the loaded item (preset / world / character), for file names.
// val: the value that was loaded; its option gives the display name.
function getSourceName(kind, page, idPfx, val) {
    const sel = page.querySelector(`#${idPfx}-sel`);
    if (!sel) return 'untitled';
    const opt = val ? [...sel.options].find(o => o.value === val) : null;
    if (!val) {
        // current
        if (kind === 'preset') return oai_settings?.preset_settings_openai || 'preset';
        return 'current';
    }
    return opt?.textContent || val || 'untitled';
}

// ── Panel ──────────────────────────────────────────────────────────────
function openPanel() {
    PDOC.getElementById('pt-panel')?.classList.remove('pt-hidden');
}
function closePanel() {
    PDOC.getElementById('pt-panel')?.classList.add('pt-hidden');
}

// Shows the model configured in the extension settings next to the status
// text. This is a straight read of the saved setting — no live detection.
function updateStatusModel() {
    const el = PDOC.getElementById('pt-status-model');
    if (!el) return;
    const model = modelName();
    el.textContent = model ? `· ${model}` : '';
    el.title = model || '';
}

// ── Translation cache backup / restore ──────────────────────────────
// Backup = a plain JSON dump of cache keys → translations. Keys already encode
// tab, source name, item id and language, so a backup restores into the same
// preset / world info names on any device — and can be shared: someone with
// the same preset name gets the translations without spending API calls.
// (Character keys use the avatar file name, which can differ between users.)
//
// Restore only ever ADDS or (with confirmation) REPLACES entries. It never
// deletes anything that is already in the cache.
const BACKUP_FORMAT = 'prompt-panel-cache';
const BACKUP_MAX_BYTES = 100 * 1024 * 1024;   // room for preserved originals
const VALID_KEY = /^pt-(preset|wi|char|names)::/;

// withOrig: also put the preserved originals in the file (checkbox, off by default)
async function exportCacheBackup(withOrig = false) {
    const entries = {};
    for (const [k, v] of translationMap.entries()) {
        if (typeof k === 'string' && typeof v === 'string' && VALID_KEY.test(k)) entries[k] = v;
    }
    const count = Object.keys(entries).length;
    let originals = null, origBytes = 0;
    if (withOrig) {
        const list = await origIndexLoad();
        if (list.length) {
            originals = {};
            for (const e of list) {
                const rec = await origGet(e.name);
                // origStrip again: copies kept by older versions may still hold connection fields
                if (rec) { originals[e.name] = { savedAt: rec.savedAt, source: rec.source, body: origStrip(rec.body) }; origBytes += e.size || 0; }
            }
        }
    }
    const nOrig = originals ? Object.keys(originals).length : 0;
    if (!count && !nOrig) {
        if (typeof toastr !== 'undefined') toastr.info(withOrig ? '백업할 번역 캐시와 보존된 원본이 없습니다' : '백업할 번역 캐시가 없습니다');
        return;
    }
    if (origBytes > 40 * 1024 * 1024 && !confirm(`보존된 원본이 커서 백업 파일이 ${fmtBytes(origBytes)} 넘게 됩니다.\n기기에 따라 만들거나 가져오는 데 시간이 걸릴 수 있어요. 계속할까요?`)) return;
    const d = new Date(), z = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${z(d.getMonth()+1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
    const payload = { format: BACKUP_FORMAT, version: 1, exportedAt: d.toISOString(), count, entries };
    if (nOrig) payload.originals = originals;
    const filename = `prompt-panel-cache_${stamp}.json`;
    downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json;charset=utf-8' }), filename);
    if (typeof toastr !== 'undefined') toastr.success(`번역 ${count.toLocaleString()}개${nOrig ? ` · 보존된 원본 ${nOrig}개` : ''}를 ${filename} 으로 백업했습니다`);
}

async function importCacheBackup(file) {
    const warn = m => { if (typeof toastr !== 'undefined') toastr.error(m); };
    if (!file) return;
    if (file.size > BACKUP_MAX_BYTES) return warn(`파일이 너무 큽니다 (최대 ${Math.round(BACKUP_MAX_BYTES / 1048576)}MB)`);

    let data;
    try { data = JSON.parse(await file.text()); }
    catch (e) { return warn('JSON 파일을 읽을 수 없습니다'); }
    if (!data || data.format !== BACKUP_FORMAT || typeof data.entries !== 'object' || data.entries === null) {
        return warn('Prompt Panel 번역 캐시 백업 파일이 아닙니다');
    }
    const orig = (data.originals && typeof data.originals === 'object' && !Array.isArray(data.originals)) ? data.originals : null;
    const hasOrig = !!orig && Object.keys(orig).length > 0;
    // A file holding only originals skips the translation step
    if (Object.keys(data.entries).length || !hasOrig) await mergeIntoCache(data.entries, '백업 파일');
    if (hasOrig) await mergeOriginals(orig);
}

// Preserved originals from a backup file. Adds new ones; replaces differing
// ones only with consent; never deletes.
async function mergeOriginals(map) {
    const toast = (t, m) => { if (typeof toastr !== 'undefined') toastr[t](m); };
    const list = await origIndexLoad();
    const fresh = [], conflict = [];
    let same = 0, invalid = 0;
    for (const [name, rec] of Object.entries(map)) {
        const body = rec && rec.body;
        if (!name || typeof name !== 'string' || !body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.prompts)) { invalid++; continue; }
        const clean = origStrip(body);
        const at = Number.isFinite(rec.savedAt) ? rec.savedAt : Date.now();
        if (!list.some(e => e.name === name)) { fresh.push([name, clean, at]); continue; }
        const old = await origGet(name);
        if (old && origSame(origStrip(old.body), clean)) same++;
        else conflict.push([name, clean, at]);
    }
    if (!fresh.length && !conflict.length) {
        toast('info', same ? '백업의 보존된 원본은 모두 이미 있습니다' : '가져올 수 있는 보존된 원본이 없습니다');
        return;
    }
    const summary = `백업 파일에 보존된 원본이 ${(fresh.length + conflict.length + same).toLocaleString()}개 들어 있습니다.\n\n`
        + `• 새로 추가: ${fresh.length}개\n• 이미 같은 원본: ${same}개\n• 지금과 다른 원본: ${conflict.length}개`
        + (invalid ? `\n• 형식이 맞지 않아 건너뜀: ${invalid}개` : '')
        + `\n\n가져올까요? 지금 보존된 원본은 삭제되지 않습니다.`;
    if (!confirm(summary)) return;
    let todo = fresh;
    if (conflict.length && confirm(`같은 이름인데 내용이 다른 보존본이 ${conflict.length}개 있습니다.\n\n[확인] 백업 파일의 원본으로 바꾸기\n[취소] 지금 원본 유지 (새 것만 추가)`)) todo = fresh.concat(conflict);
    if (!todo.length) { toast('info', '추가하거나 바꿀 보존된 원본이 없습니다'); return; }
    let done = 0;
    for (const [name, body, at] of todo) {
        try { await origSave(name, body, 'backup', at); done++; }
        catch (e) { console.warn(`[${EXT}] restore original ${name}`, e); }
    }
    if (done === todo.length) toast('success', `보존된 원본 ${done}개를 가져왔습니다`);
    else toast('warning', `보존된 원본 ${done}개를 가져왔고 ${todo.length - done}개는 저장하지 못했습니다`);
}

// Backup file import. Adds new entries, and replaces differing ones only with explicit consent.
// Never deletes anything already in the cache.
async function mergeIntoCache(entries, sourceLabel) {
    const warn = m => { if (typeof toastr !== 'undefined') toastr.error(m); };
    // Classify every entry before touching anything
    const fresh = [], conflict = [];
    let same = 0, invalid = 0;
    for (const [k, v] of Object.entries(entries)) {
        if (typeof k !== 'string' || !VALID_KEY.test(k) || typeof v !== 'string' || !v) { invalid++; continue; }
        const cur = translationMap.get(k);
        if (cur === undefined) fresh.push([k, v]);
        else if (cur === v) same++;
        else conflict.push([k, v]);
    }
    const total = fresh.length + conflict.length + same;
    if (!total) return warn('가져올 수 있는 번역이 없습니다');

    const summary =
        `${sourceLabel}의 번역: ${total.toLocaleString()}개\n\n` +
        `• 새로 추가: ${fresh.length.toLocaleString()}개\n` +
        `• 이미 같은 번역: ${same.toLocaleString()}개\n` +
        `• 지금과 다른 번역: ${conflict.length.toLocaleString()}개` +
        (invalid ? `\n• 형식이 맞지 않아 건너뜀: ${invalid.toLocaleString()}개` : '') +
        `\n\n가져올까요? 기존 번역은 삭제되지 않습니다.`;
    if (!confirm(summary)) return;

    let toWrite = fresh;
    if (conflict.length) {
        const overwrite = confirm(
            `지금 저장된 번역과 내용이 다른 항목이 ${conflict.length.toLocaleString()}개 있습니다.\n\n` +
            `[확인] ${sourceLabel}의 번역으로 바꾸기\n[취소] 지금 번역 유지 (새 항목만 추가)`
        );
        if (overwrite) toWrite = fresh.concat(conflict);
    }
    if (!toWrite.length) {
        if (typeof toastr !== 'undefined') toastr.info('추가하거나 바꿀 번역이 없습니다');
        return;
    }

    let saved = true;
    try { await dbPutMany(toWrite); }
    catch (e) { saved = false; console.warn(`[${EXT}] backup import: IndexedDB write failed`, e); }
    // Memory is updated either way so the session reflects the import
    for (const [k, v] of toWrite) translationMap.set(k, v);
    updateCacheStatsUI();

    if (typeof toastr !== 'undefined') {
        if (saved) toastr.success(`번역 ${toWrite.length.toLocaleString()}개를 가져왔습니다. 패널에서 다시 불러오면 반영됩니다.`);
        else toastr.warning('저장소에 기록하지 못했습니다. 이번 세션에만 적용되며, 새로고침하면 사라집니다.');
    }
}

function applyFontSizes() {
    const p = PDOC.getElementById('pt-panel');
    if (!p) return;
    const c = cfg();
    p.style.setProperty('--pt-original-size', (c.originalFontSize || 11) + 'px');
    p.style.setProperty('--pt-translated-size', (c.translatedFontSize || 12) + 'px');
}

function buildPanel() {
    PDOC.getElementById('pt-panel')?.remove();
    const panel=PDOC.createElement('div');
    panel.id='pt-panel';
    panel.classList.add('pt-hidden');
    panel.setAttribute('data-pt-theme', cfg().theme||'dark');
    // 글자 크기 CSS 변수 주입
    const _c = cfg();
    panel.style.setProperty('--pt-original-size', (_c.originalFontSize || 11) + 'px');
    panel.style.setProperty('--pt-translated-size', (_c.translatedFontSize || 12) + 'px');
    panel.innerHTML=`
        <div id="pt-panel-header">
            <h3>${esc(BUILD.title)}</h3>
            <div style="display:flex;align-items:center;gap:4px;">
                <button id="pt-panel-ask" title="질문하기" aria-label="질문하기"><i class="fa-solid fa-comment-dots"></i></button>
                <button id="pt-panel-refresh" title="목록 새로고침" aria-label="새로고침">↻</button>
                <button id="pt-panel-close" title="닫기" aria-label="닫기">✕</button>
            </div>
        </div>
        <div id="pt-tabs">
            <button class="pt-tab active" data-tab="preset">프리셋</button>
            <button class="pt-tab pt-tab-mini" data-tab="diff" title="프리셋 비교 (베타)" aria-label="프리셋 비교 (베타)"><i class="fa-solid fa-code-compare"></i></button>
            <button class="pt-tab" data-tab="wi">월드인포</button>
            <button class="pt-tab" data-tab="char">봇카드</button>
        </div>
        <div id="pt-panel-content">
            <div class="pt-page active" id="pt-page-preset"></div>
            <div class="pt-page"        id="pt-page-diff"></div>
            <div class="pt-page"        id="pt-page-wi"></div>
            <div class="pt-page"        id="pt-page-char"></div>
        </div>
        <div id="pt-statusbar">
            <div style="display:flex;align-items:center;gap:6px;min-width:0;">
                <div class="pt-status-dot" id="pt-status-dot"></div>
                <span id="pt-status-text">대기 중</span>
                <span class="pt-status-model" id="pt-status-model"></span>
            </div>
        </div>`;
    PDOC.body.appendChild(panel);

    panel.querySelectorAll('.pt-tab').forEach(tab=>tab.addEventListener('click',()=>{
        panel.querySelectorAll('.pt-tab').forEach(t=>t.classList.remove('active'));
        panel.querySelectorAll('.pt-page').forEach(p=>p.classList.remove('active'));
        tab.classList.add('active');
        panel.querySelector(`#pt-page-${tab.dataset.tab}`).classList.add('active');
    }));
    updateStatusModel();
    panel.querySelector('#pt-panel-close').addEventListener('click',closePanel);
    panel.querySelector('#pt-panel-ask').addEventListener('click', () => {
        const tab = panel.querySelector('.pt-tab.active')?.dataset.tab || 'preset';
        if (!ASK_CONTROLLERS[tab]) {
            if (typeof toastr !== 'undefined') toastr.info('비교 탭에서는 질문하기를 쓸 수 없어요. 프리셋 탭에서 사용해 주세요.');
            return;
        }
        ASK_CONTROLLERS[tab].open();
    });

    // Refresh button: rebuild select dropdowns only. Loaded items and translation cache are untouched.
    panel.querySelector('#pt-panel-refresh').addEventListener('click', async () => {
        try {
            // Re-import modules to get the latest references.
            // ST may reassign these collections (not just mutate them) when
            // presets/world info/characters are added or removed, so our
            // captured references can become stale. Re-importing forces ESM
            // to give us the current live bindings.
            try {
                const s = import.meta.url;
                const tp = s.includes('/third-party/');
                const base  = tp ? '../../../../' : '../../../';
                const base2 = tp ? '../../../'    : '../../';
                const sm = await import(base + 'script.js');
                characters            = sm.characters;
                const om = await import(base2 + 'openai.js');
                openai_settings      = om.openai_settings;
                openai_setting_names = om.openai_setting_names;
                const wi = await import(base2 + 'world-info.js');
                world_names = wi.world_names;
                world_info  = wi.world_info;
            } catch (impErr) {
                console.warn(`[${EXT}] refresh: re-import failed, falling back to cached refs`, impErr);
            }

            const refreshSelect = (idPfx, listFn) => {
                const sel = panel.querySelector(`#${idPfx}-sel`);
                if (!sel) return;
                const currentVal = sel.value;
                const items = listFn() || [];
                const fragment = ['<option value="">— 선택 —</option>']
                    .concat(items.map(it => `<option value="${esc(it.id)}">${esc(it.name)}</option>`));
                sel.innerHTML = fragment.join('');
                // Preserve previous selection if it still exists
                if (currentVal && [...sel.options].some(o => o.value === currentVal)) {
                    setSelValue(sel, currentVal);
                }
            };
            refreshSelect('pt-preset', listAllPresets);
            // The compare tab fills its own lists (A also holds originals and an open file)
            if (refillDiffLists) refillDiffLists();
            else { refreshSelect('pt-diffa', listAllPresets); refreshSelect('pt-diffb', listAllPresets); }
            refreshSelect('pt-wi',     listAllWorldInfos);
            refreshSelect('pt-char',   listAllCharacters);
            if (typeof toastr !== 'undefined') toastr.success('목록을 새로고침했습니다');
        } catch (e) {
            console.error(`[${EXT}] refresh failed`, e);
            if (typeof toastr !== 'undefined') toastr.error('새로고침 실패');
        }
    });

    buildPage({page:panel.querySelector('#pt-page-preset'),idPfx:'pt-preset',listFn:listAllPresets,loadFn:readPresetBlocks,selectable:true,icon:'📋',hint:'프리셋을 선택하고 로드하세요.',isAsync:false,kind:'preset'});
    buildDiffPage(panel.querySelector('#pt-page-diff'));
    buildPage({page:panel.querySelector('#pt-page-wi'),idPfx:'pt-wi',listFn:listAllWorldInfos,loadFn:readWorldInfo,selectable:true,icon:'🌍',hint:'월드인포를 선택하고 로드하세요.',isAsync:true,kind:'wi'});
    buildPage({page:panel.querySelector('#pt-page-char'),idPfx:'pt-char',listFn:listAllCharacters,loadFn:readCharCard,selectable:true,icon:'🃏',hint:'캐릭터를 선택하고 로드하세요.',isAsync:true,kind:'char'});

    try { const cur=getCurrentPresetName(); if(cur)setSelValue(panel.querySelector('#pt-preset-sel'),cur); } catch(e){}

    // 패널 내 CSS 로드
    if (CSS_URL && !PDOC.getElementById('pt-panel-css')) {
        const link=PDOC.createElement('link');
        link.id='pt-panel-css'; link.rel='stylesheet'; link.href=CSS_URL;
        PDOC.head.appendChild(link);
    }
}

// ── Floating Action Button (FAB) ─────────────────────────────────────
// Where the button goes in the current window: the saved spot (or the default
// bottom-right one), kept 8px inside the edges.
function fabPlace() {
    const rawPos = cfg().fabPos || {};
    const vw = PAR.innerWidth || 400;
    const vh = PAR.innerHeight || 800;
    const FAB_SIZE = 52;
    // 기본 위치: 우측 하단 (right:16, bottom:90) → top/left 변환
    const left = rawPos.left !== undefined ? rawPos.left : vw - FAB_SIZE - 16;
    const top  = rawPos.top  !== undefined ? rawPos.top  : vh - FAB_SIZE - 90;
    return {
        left: Math.max(8, Math.min(vw - FAB_SIZE - 8, left)),
        top:  Math.max(8, Math.min(vh - FAB_SIZE - 8, top)),
    };
}

function buildFab() {
    // cleanup
    PDOC.getElementById('pt-fab')?.remove();
    PDOC.getElementById('pt-fab-css')?.remove();
    if (cfg().fabVisible === false) return;

    // CSS로 강제 표시 — ST의 어떤 레이어도 못 가리게
    // isolation: isolate 를 쓰면 안 되고 반대로 우리 FAB 위에 새 stacking context 생성을 막아야 함
    // 가장 확실한 방법: <style>을 parent document head에 직접 삽입
    const style = PDOC.createElement('style');
    style.id = 'pt-fab-css';
    style.textContent = `
        #pt-fab {
            position: fixed !important;
            z-index: 2147483647 !important;
            pointer-events: auto !important;
            visibility: visible !important;
            opacity: 1 !important;
            display: flex !important;
            clip: auto !important;
            clip-path: none !important;
            transform: none;
            overflow: visible !important;
        }
    `;
    PDOC.head.appendChild(style);

    const fab = PDOC.createElement('div');
    fab.id = 'pt-fab';
    fab.setAttribute('role', 'button');
    fab.setAttribute('tabindex', '0');
    fab.title = '번역 패널';
    fab.textContent = '🐳';

    // 저장된 위치 복원 + 화면 밖 방지 (viewport clamp)
    // bottom/right 사용 시 부모의 transform 때문에 잘못 계산되는 이슈가 있어서
    // 항상 top/left로 명시적 좌표 사용
    const { left: finalLeft, top: finalTop } = fabPlace();

    Object.assign(fab.style, {
        position:       'fixed',
        left:           finalLeft + 'px',
        top:            finalTop + 'px',
        right:          'auto',
        bottom:         'auto',
        zIndex:         '2147483647',
        width:          '52px',
        height:         '52px',
        background:     'transparent',
        border:         'none',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        cursor:         'grab',
        userSelect:     'none',
        touchAction:    'none',
        webkitUserSelect: 'none',
        fontSize:       '36px',
        lineHeight:     '1',
        padding:        '0',
        margin:         '0',
        pointerEvents:  'auto',
        visibility:     'visible',
        opacity:        '1',
        filter:         'drop-shadow(0 2px 8px rgba(0,0,0,.5))',
        transition:     'transform .1s',
        overflow:       'visible',
    });

    // 마운트: documentElement(<html>)에 직접 attach하면 어떤 transform/containing block 영향도 안 받음
    // body에 붙으면 부모 중에 transform 있을 때 position:fixed가 그 기준으로 계산되는 버그 회피
    const mountTarget = PDOC.documentElement || PDOC.body;
    mountTarget.appendChild(fab);

    // DOM에서 제거되면 재부착
    const ensureMounted = () => {
        const existing = PDOC.getElementById('pt-fab');
        if (!existing && cfg().fabVisible !== false) {
            mountTarget.appendChild(fab);
        } else if (existing && existing !== fab) {
            existing.remove();
            mountTarget.appendChild(fab);
        }
    };
    clearInterval(window[BUILD.fabKey]);
    window[BUILD.fabKey] = setInterval(ensureMounted, 1500);
    // Window resized or phone rotated: bring the button back on screen. Runs
    // only on resize (no polling). The saved position is not changed, so the
    // button returns to it when the window is large enough again.
    const resizeKey = BUILD.fabKey + '_resize';
    if (!PAR[resizeKey]) {
        let t = 0;
        PAR[resizeKey] = () => {
            clearTimeout(t);
            t = setTimeout(() => {
                const el = PDOC.getElementById('pt-fab');
                if (!el || el.dataset.dragging) return;
                const p = fabPlace();
                el.style.left = p.left + 'px';
                el.style.top = p.top + 'px';
            }, 150);
        };
        PAR.addEventListener('resize', PAR[resizeKey], { passive: true });
    }

    // 드래그
    let dragging = false, moved = false, sx = 0, sy = 0, il = 0, it = 0;

    fab.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
        dragging = true; moved = false;
        fab.dataset.dragging = '1';
        fab.style.cursor = 'grabbing';
        fab.style.transform = 'scale(1.15)';
        const r = fab.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; il = r.left; it = r.top;
        fab.style.right  = 'auto'; fab.style.bottom = 'auto';
        fab.style.left   = r.left + 'px'; fab.style.top = r.top + 'px';
        try { fab.setPointerCapture(e.pointerId); } catch(er) {}
    });

    fab.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        const vw = PAR.innerWidth, vh = PAR.innerHeight;
        fab.style.left = Math.max(0, Math.min(vw - 52, il + dx)) + 'px';
        fab.style.top  = Math.max(0, Math.min(vh - 52, it + dy)) + 'px';
    });

    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        delete fab.dataset.dragging;
        fab.style.cursor = 'grab';
        fab.style.transform = '';
        if (moved) {
            const r = fab.getBoundingClientRect();
            cfg().fabPos = { left: Math.round(r.left), top: Math.round(r.top) };
            saveSettingsDebounced();
        } else {
            const panel = PDOC.getElementById('pt-panel');
            if (panel) panel.classList.contains('pt-hidden') ? openPanel() : closePanel();
        }
    };
    fab.addEventListener('pointerup', onUp);
    fab.addEventListener('pointercancel', onUp);
}

// ── Settings HTML ──────────────────────────────────────────────────────
function buildSettingsHTML() {
    const c=cfg();
    const langOpts=[['Korean','한국어'],['English','English'],['Japanese','日本語'],['Chinese (Simplified)','简体中文'],['Chinese (Traditional)','繁體中文'],['Polish','Polski'],['__custom__','⚙️ 직접 입력']]
        .map(([v,l])=>`<option value="${v}" ${c.targetLang===v?'selected':''}>${l}</option>`).join('');
    const isCustomLang = c.targetLang === '__custom__';
    // A saved service that is no longer listed keeps working, so it stays visible
    const svcKeys = SERVICES[c.provider] ? Object.keys(SERVICES) : [...Object.keys(SERVICES), c.provider];
    const provOpts = svcKeys.map(k => `<option value="${esc(k)}"${c.provider === k ? ' selected' : ''}>${esc(SERVICES[k] ? SERVICES[k].label : k + ' (목록에서 빠짐)')}</option>`).join('');
    const modelOpts = modelOptions(c.provider, c.model), isCustomMdl = c.model === MODEL_TYPED, isCustomSvc = c.provider === 'custom';
    const themeOpts=[['dark','🌙 Dark'],['light','☀️ Light'],['pink','🌸 Pink'],['mint','🌿 Mint'],['orange','🍊 Orange'],['blue','💙 Blue']]
        .map(([v,l])=>`<option value="${v}" ${c.theme===v?'selected':''}>${l}</option>`).join('');

    return `
<div class="pt-extension-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>${esc(BUILD.title)}</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <!-- (1) 프롬프트 패널 구역 -->
      <label style="font-weight:600;font-size:13px;display:block;margin-bottom:6px;">프롬프트 패널</label>
      <div class="pt-ext-row" style="margin-top:2px;"><button id="pt-open-panel-btn" class="menu_button" style="flex:1;"><i class="fa-solid fa-language"></i>&nbsp;패널 열기</button></div>
      <label class="checkbox_label" style="margin-top:8px;margin-bottom:2px;"><input type="checkbox" id="pt-fab-toggle" ${c.fabVisible!==false?'checked':''} class="checkbox"><span>플로팅 버튼 표시🐳</span></label>
      <small style="display:block;margin-left:24px;margin-bottom:8px;color:var(--SmartThemeQuoteColor,#888);font-size:11px;line-height:1.5;">언제든지 패널을 열 수 있는 아이콘입니다.</small>
      <div class="pt-ext-row"><label for="pt-target-lang">번역 언어</label><select id="pt-target-lang" class="text_pole" style="max-width:160px;">${langOpts}</select></div>
      <div id="pt-custom-lang-row" class="pt-ext-row" style="${isCustomLang?'':'display:none;'}"><label for="pt-custom-lang">Language</label><input id="pt-custom-lang" class="text_pole" type="text" value="${esc(c.customLang||'')}" placeholder="예: Français, Español" style="max-width:160px;"></div>
      <small id="pt-custom-lang-hint" style="display:${isCustomLang?'block':'none'};margin-bottom:8px;color:var(--SmartThemeQuoteColor,#888);font-size:11px;line-height:1.5;">번역 요청에 그대로 쓰이는 값입니다. 영어 언어명 권장 (예: French).</small>
      <div class="pt-ext-row"><label for="pt-title-batch">제목 번역 묶음 개수</label><input id="pt-title-batch" class="text_pole" type="number" min="1" max="50" step="1" value="${c.titleBatchSize||15}" style="max-width:80px;"></div>
      <div class="pt-ext-row"><label for="pt-req-delay">요청 간 대기(ms)</label><input id="pt-req-delay" class="text_pole" type="number" min="0" max="60000" step="50" value="${c.requestDelayMs??60}" style="max-width:80px;"></div>
      <small style="display:block;margin-bottom:8px;color:var(--SmartThemeQuoteColor,#888);font-size:11px;line-height:1.5;">"제목만" 번역은 여러 제목을 한 요청으로 묶어 보냅니다. 본문 번역은 항상 토글 1개당 1요청이며, 대기 시간으로 속도를 조절합니다. API 분당 한도(예: Vertex AI)에 걸리면 묶음 개수를 늘리고 대기 시간을 키우세요.</small>
      <div class="pt-ext-row"><label for="pt-theme">테마</label><select id="pt-theme" class="text_pole" style="max-width:160px;">${themeOpts}</select></div>
      <div class="pt-ext-row pt-slider-row">
        <label for="pt-orig-size">원문 글자 크기</label>
        <input type="range" id="pt-orig-size" min="9" max="18" step="1" value="${c.originalFontSize||11}">
        <span id="pt-orig-size-val" class="pt-slider-val">${c.originalFontSize||11}px</span>
      </div>
      <div class="pt-ext-row pt-slider-row">
        <label for="pt-trans-size">번역문 글자 크기</label>
        <input type="range" id="pt-trans-size" min="10" max="20" step="1" value="${c.translatedFontSize||12}">
        <span id="pt-trans-size-val" class="pt-slider-val">${c.translatedFontSize||12}px</span>
      </div>

      <!-- Sections below open on tap: ST's inline-drawer markup and look, opened at once by our own handler (see init) -->
      <div class="inline-drawer pt-ext-sec" id="pt-sec-api">
        <div class="inline-drawer-toggle inline-drawer-header pt-ext-sec-head"><span class="pt-ext-sec-title">API 설정</span><span class="pt-ext-sec-tools"><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></span></div>
        <div class="inline-drawer-content">
          <div class="pt-ext-row"><label>프로바이더</label><select id="pt-provider" class="text_pole" style="max-width:180px;">${provOpts}</select></div>
          <div id="pt-custom-wrap" style="${isCustomSvc?'':'display:none;'}">
            <div class="pt-ext-row"><label>엔드포인트 URL</label><input id="pt-custom-url" class="text_pole" type="text" value="${esc(c.customUrl||'')}" placeholder="https://.../v1" style="max-width:200px;"></div>
            <div class="pt-ext-row"><label>API 키</label><input id="pt-custom-key" class="text_pole" type="password" autocomplete="new-password" placeholder="(이 기기에만 저장)" style="max-width:200px;"></div>
            <div class="pt-ext-row"><small id="pt-custom-msg" style="flex:1;min-width:0;font-size:11px;line-height:1.5;overflow-wrap:anywhere;color:var(--SmartThemeQuoteColor,#888);"></small><button id="pt-custom-models" class="menu_button" style="font-size:11px;white-space:nowrap;margin:0;">모델 목록 불러오기</button></div>
            <small style="display:block;margin-bottom:8px;color:var(--SmartThemeQuoteColor,#888);font-size:11px;line-height:1.5;">OpenAI 호환 주소(보통 /v1로 끝남)를 넣습니다. 키를 비워 두면 실리태번에 <b>같은 주소로</b> 저장된 키(연결 프로필, 프록시 프리셋, Custom 연결)를 찾아 씁니다. 없으면 키 없이 보냅니다.</small>
          </div>
          <div class="pt-ext-row"><label>모델</label><select id="pt-model-select" class="text_pole" style="max-width:180px;">${modelOpts}</select></div>
          <div id="pt-custom-model-row" class="pt-ext-row" style="${isCustomMdl?'':'display:none;'}"><label>모델명 입력</label><input id="pt-model-custom" class="text_pole" type="text" value="${esc(c.customModelName||'')}" placeholder="모델명 직접 입력" style="max-width:180px;"></div>
          <div id="pt-params-wrap" style="margin-top:4px;"></div>
          <div id="pt-proxy-block" style="${isCustomSvc?'display:none;':''}">
          <label class="checkbox_label" style="margin-top:10px;margin-bottom:6px;"><input type="checkbox" id="pt-use-proxy" ${c.useReverseProxy?'checked':''}><span>리버스 프록시 사용</span></label>
          <div id="pt-proxy-wrap" style="${c.useReverseProxy?'':'display:none;'}">
            <div class="pt-ext-row"><label>프록시 URL</label><input id="pt-proxy-url" class="text_pole" type="text" value="${esc(c.reverseProxyUrl||'')}" placeholder="https://..." style="max-width:200px;"></div>
            <div class="pt-ext-row"><label>프록시 비밀번호</label><input id="pt-proxy-pw" class="text_pole" type="password" value="${esc(c.reverseProxyPassword||'')}" placeholder="(선택)" style="max-width:200px;"></div>
          </div>
          </div>
        </div>
      </div>
      <div class="inline-drawer pt-ext-sec" id="pt-sec-prefill">
        <div class="inline-drawer-toggle inline-drawer-header pt-ext-sec-head"><span class="pt-ext-sec-title">Prefill</span><span class="pt-ext-sec-tools"><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></span></div>
        <div class="inline-drawer-content">
          <label class="checkbox_label" style="margin-bottom:6px;"><input type="checkbox" id="pt-prefill-toggle" ${c.prefillEnabled!==false?'checked':''}><span>번역 프리필 사용</span></label>
          <textarea id="pt-prefill-text" class="text_pole" rows="2" style="width:100%;font-size:11px;resize:vertical;margin-bottom:2px;">${esc(c.prefillText||'')}</textarea>
          <small style="display:block;margin-bottom:8px;color:var(--SmartThemeQuoteColor,#888);font-size:11px;line-height:1.5;">프리필을 받지 않는 모델(Gemini 3.5 이후, Claude 4.6 이후)과 Custom 엔드포인트에는 켜져 있어도 보내지 않습니다.</small>
        </div>
      </div>
      <div class="inline-drawer pt-ext-sec" id="pt-sec-glossary">
        <div class="inline-drawer-toggle inline-drawer-header pt-ext-sec-head"><span class="pt-ext-sec-title">프리셋 용어집</span><span class="pt-ext-sec-tools"><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></span></div>
        <div class="inline-drawer-content">
          <small style="display:block;margin-bottom:6px;color:var(--SmartThemeQuoteColor,#888);font-size:11px;line-height:1.5;">프리셋 탭 번역에만 적용됩니다. 한 줄에 하나씩 <code>원어 = 뜻 | 메모</code> 형식으로 적고, 원어가 여러 개면 <code>/</code>로 구분하세요. 번역할 글에 실제로 등장하는 용어만 요청에 포함됩니다.</small>
          <textarea id="pt-glossary" class="text_pole" rows="8" spellcheck="false" style="width:100%;font-size:11px;line-height:1.5;resize:vertical;margin-bottom:6px;"></textarea>
          <div id="pt-glossary-count" style="text-align:right;font-size:11px;color:var(--SmartThemeQuoteColor,#888);font-variant-numeric:tabular-nums;margin:-2px 0 6px 0;">–</div>
          <div class="pt-ext-row">
            <button id="pt-glossary-reset" class="menu_button" style="flex:1;white-space:nowrap;justify-content:center;"><i class="fa-solid fa-rotate-left"></i>&nbsp;기본값</button>
            <button id="pt-glossary-save" class="menu_button" style="flex:1;white-space:nowrap;justify-content:center;"><i class="fa-solid fa-floppy-disk"></i>&nbsp;저장</button>
          </div>
        </div>
      </div>
      <div class="inline-drawer pt-ext-sec" id="pt-sec-ask">
        <div class="inline-drawer-toggle inline-drawer-header pt-ext-sec-head"><span class="pt-ext-sec-title">질문하기 <span class="pt-ext-badge">베타</span></span><span class="pt-ext-sec-tools"><i class="fa-solid fa-circle-info pt-info-btn" data-info="pt-ask-info" role="button" tabindex="0" aria-label="도움말" title="도움말"></i><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></span></div>
        <div class="inline-drawer-content">
          <div class="pt-ext-row"><label for="pt-ask-budget">최대 자료 분량 (토큰)</label><input id="pt-ask-budget" class="text_pole" type="number" min="1000" max="2000000" step="1000" value="${c.askBudget ?? 60000}" style="max-width:110px;"></div>
          <div class="pt-ext-row"><label for="pt-ask-maxtok">최대 답변 길이 (토큰)</label><input id="pt-ask-maxtok" class="text_pole" type="number" min="0" max="200000" step="256" value="${c.askMaxTokens ?? 0}" style="max-width:110px;"></div>
          <div class="pt-ext-row"><label for="pt-ask-temp">온도</label><input id="pt-ask-temp" class="text_pole" type="number" min="0" max="2" step="0.1" value="${typeof c.askTemperature === 'number' ? c.askTemperature : ''}" placeholder="번역 설정" style="max-width:110px;"></div>
          <small id="pt-ask-info" style="display:none;margin-bottom:8px;color:var(--SmartThemeQuoteColor,#888);font-size:11px;line-height:1.5;">최대 자료 분량을 넘으면 꺼진 항목과 스크립트부터 줄여서 보냅니다. 토큰은 추론도 포함하므로, 최신모델일수록 넉넉하게 설정하는 것을 권합니다. 최대 답변 길이를 0으로 두면 모델 기본값을 쓰며, 온도를 비워두면 번역 설정을 따릅니다.</small>
        </div>
      </div>
      <div class="inline-drawer pt-ext-sec" id="pt-sec-orig">
        <div class="inline-drawer-toggle inline-drawer-header pt-ext-sec-head"><span class="pt-ext-sec-title">프리셋 원본 보존</span><span class="pt-ext-sec-tools"><i class="fa-solid fa-circle-info pt-info-btn" data-info="pt-orig-info" role="button" tabindex="0" aria-label="도움말" title="도움말"></i><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></span></div>
        <div class="inline-drawer-content">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 6px 0;font-size:11px;color:var(--SmartThemeQuoteColor,#888);">
            <span>보존된 원본</span>
            <span id="pt-orig-stats" style="font-variant-numeric:tabular-nums;">–</span>
          </div>
          <div class="pt-ext-row"><button id="pt-orig-list-btn" class="menu_button" style="flex:1;white-space:nowrap;justify-content:center;"><i class="fa-solid fa-list"></i>&nbsp;목록 보기</button></div>
          <div id="pt-orig-list" style="display:none;margin-bottom:6px;"></div>
          <label class="checkbox_label" style="font-size:12px;margin:2px 0 6px;"><input type="checkbox" id="pt-orig-auto" ${c.autoPreserveImport ? 'checked' : ''}><span>실리태번에서 프리셋을 가져올 때 자동으로 보존</span></label>
          <small id="pt-orig-info" style="display:none;margin-bottom:8px;color:var(--SmartThemeQuoteColor,#888);font-size:11px;line-height:1.5;">프리셋 탭의 원본 보존을 누르면 실리태번에 저장된 상태 그대로 보관합니다. 프리셋마다 원본은 1개를 보존합니다. 보존 원본은 브라우저에만 저장되므로 기기를 옮길 때는 번역 캐시 백업에서 '보존된 원본도 함께 백업'을 켜세요. 자동 보존을 켜면 실리태번의 프리셋을 가져올 때마다 보관하며, 같은 이름의 원본이 이미 있으면 바꾸지 않습니다.</small>
        </div>
      </div>
      <div class="inline-drawer pt-ext-sec" id="pt-sec-cache">
        <div class="inline-drawer-toggle inline-drawer-header pt-ext-sec-head"><span class="pt-ext-sec-title">번역 캐시</span><span class="pt-ext-sec-tools"><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></span></div>
        <div class="inline-drawer-content">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 6px 0;font-size:11px;color:var(--SmartThemeQuoteColor,#888);">
            <span>저장된 번역</span>
            <span id="pt-cache-stats" style="font-variant-numeric:tabular-nums;">–</span>
          </div>
          <div class="pt-ext-row">
            <button id="pt-cache-export-btn" class="menu_button" style="flex:1;white-space:nowrap;justify-content:center;"><i class="fa-solid fa-download"></i>&nbsp;백업</button>
            <button id="pt-cache-import-btn" class="menu_button" style="flex:1;white-space:nowrap;justify-content:center;"><i class="fa-solid fa-upload"></i>&nbsp;가져오기</button>
          </div>
          <label class="checkbox_label" id="pt-cache-with-orig-row" style="display:none;font-size:12px;margin:0 0 6px;"><input type="checkbox" id="pt-cache-with-orig"><span>보존된 원본도 함께 백업</span></label>
          <input type="file" id="pt-cache-import-file" accept=".json,application/json" style="display:none;">
          <div class="pt-ext-row"><button id="pt-clear-cache-btn" class="menu_button" style="flex:1;white-space:nowrap;justify-content:center;color:#e06060;"><i class="fa-solid fa-trash"></i>&nbsp;전체 캐시 삭제</button></div>
          <small style="display:block;margin-bottom:8px;color:var(--SmartThemeQuoteColor,#888);font-size:11px;line-height:1.5;">번역 데이터는 브라우저 IndexedDB에 저장됩니다. 가져오기는 기존 번역을 지우지 않습니다.</small>
        </div>
      </div>

    </div>
  </div>
</div>`;
}

// Looks of the folding sections in the extension settings (all themes)
function ensureDrawerCss() {
    if (document.getElementById('pt-drawer-css')) return;
    const st = document.createElement('style');
    st.id = 'pt-drawer-css';
    st.textContent = `
.pt-extension-settings .pt-ext-sec{border-top:1px solid var(--SmartThemeBorderColor,rgba(128,128,128,.3))}
.pt-extension-settings #pt-sec-cache{border-bottom:1px solid var(--SmartThemeBorderColor,rgba(128,128,128,.3))}
.pt-extension-settings .pt-ext-sec-head{padding:9px 2px;gap:8px}
.pt-extension-settings .pt-ext-sec-title{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px}
.pt-extension-settings .pt-ext-badge{font-size:10px;font-weight:400;line-height:1.5;padding:0 6px;border:1px solid currentColor;border-radius:999px;opacity:.65}
.pt-extension-settings .pt-ext-sec-tools{display:flex;align-items:center;gap:12px}
.pt-extension-settings .pt-ext-sec-tools .pt-info-btn{cursor:pointer;opacity:.6}
.pt-extension-settings .pt-ext-sec>.inline-drawer-content{padding:2px 2px 8px}
`;
    document.head.appendChild(st);
}

// <option> list of the model box for one service
function modelOptions(key, picked) {
    const opt = (v, text) => `<option value="${esc(v)}"${v === picked ? ' selected' : ''}>${esc(text)}</option>`;
    const listed = key === 'custom' ? customModels : serviceRow(key).models;
    // A saved model that is not in the list (older, or typed for another service) is still shown
    const names = !picked || picked === MODEL_TYPED || listed.includes(picked) ? listed : [picked, ...listed];
    return opt('', '모델 선택...') + names.map(m => opt(m, m)).join('') + opt(MODEL_TYPED, '⚙️ 커스텀 모델 입력');
}
// Model box and the rows that depend on the service / model, from the saved settings
function showModelBox(refill) {
    const c = cfg(), sel = document.getElementById('pt-model-select'), isCustom = c.provider === 'custom';
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    if (sel && refill) sel.innerHTML = modelOptions(c.provider, c.model);
    show('pt-custom-model-row', c.model === MODEL_TYPED);
    show('pt-custom-wrap', isCustom);
    show('pt-proxy-block', !isCustom);
    if (isCustom) showKeyHint();
}
// The empty key box says which saved key would be used for the address
function showKeyHint() {
    const el = document.getElementById('pt-custom-key'); if (!el) return;
    const saved = savedKeyFor(customUrl());
    el.placeholder = saved ? `비워 두면 ${saved.from}` : '(이 기기에만 저장)';
}

function updateCacheStatsUI() {
    const el = document.getElementById('pt-cache-stats');
    if (!el) return;
    const { count, sizeStr } = getCacheStats();
    el.textContent = `${count.toLocaleString()}개 · ${sizeStr}`;
}

// Sampling values of the chosen service: a slider and a number box each, and
// "back to defaults". Their events are handled once, on the wrapper (see init).
function showKnobs() {
    const wrap = document.getElementById('pt-params-wrap'); if (!wrap) return;
    const saved = savedKnobs();
    wrap.innerHTML = serviceRow(cfg().provider).knobs.map(k => {
        const d = KNOBS[k], at = `data-pkey="${k}" min="${d.min}" max="${d.max}" step="${d.step}" value="${knob(saved, k)}"`;
        return `<div class="pt-param-row"><label class="pt-param-label">${d.label}</label><input type="range" class="pt-param-slider" ${at}><input type="number" class="pt-param-num" ${at}></div>`;
    }).join('') + '<button class="menu_button" id="pt-params-reset" style="font-size:11px;margin-top:4px;width:100%;">기본값으로 재설정</button>'
        + '<small id="pt-knobs-note" style="display:none;margin-top:4px;color:var(--SmartThemeQuoteColor,#888);font-size:11px;line-height:1.5;">이 모델은 Temperature 등 샘플링 값을 받지 않으므로 보내지 않습니다.</small>';
    showKnobNote();
}
// Says so when the chosen model takes no sampling values (finalizeRequest leaves them out)
function showKnobNote() {
    const el = document.getElementById('pt-knobs-note'); if (!el) return;
    const c = cfg(), probe = finalizeRequest({ chat_completion_source: serviceRow(c.provider).source || c.provider, model: modelName(), temperature: 1 });
    el.style.display = probe.temperature === undefined ? 'block' : 'none';
}

// ── Init ───────────────────────────────────────────────────────────────
jQuery(async()=>{
    console.log(`[${EXT}] init start`);
    try { await initImports(); } catch(e) { console.error(`[${EXT}] initImports failed`, e); return; }
    console.log(`[${EXT}] imports OK`);

    // The release and test builds share element ids, so running both at once
    // would make them overwrite each other's UI. If one is already up, stay
    // out of the way. (Separate settings and storage mean no data risk.)
    if (PDOC.getElementById('pt-panel') || document.querySelector('#extensions_settings .pt-extension-settings')) {
        console.warn(`[${EXT}] another Prompt Panel build is already running — not started`);
        if (typeof toastr !== 'undefined') {
            toastr.warning(`다른 Prompt Panel이 이미 켜져 있어 ${BUILD.title}을(를) 시작하지 않았습니다. 확장 관리에서 하나만 켜 주세요.`, BUILD.title, { timeOut: 8000 });
        }
        return;
    }

    try {
        ensureDrawerCss();
        $('#extensions_settings').append(buildSettingsHTML());
    } catch(e) {
        console.error(`[${EXT}] buildSettingsHTML failed`, e);
        return;
    }
    if (CSS_URL) {
        $('<link>',{id:'pt-main-css',rel:'stylesheet',href:CSS_URL}).appendTo('head');
    }

    // Load the translation cache (IndexedDB) into memory
    try { await initTranslationCache(); } catch(e) { console.warn(`[${EXT}] cache init failed, using in-memory only`, e); }
    // 이전 버전 잔여물 정리
    let _needsSave = false;
    if (cfg()._fabDiag !== undefined) { delete cfg()._fabDiag; _needsSave = true; }
    if (cfg().useMainApi !== undefined) { delete cfg().useMainApi; _needsSave = true; }
    if (_needsSave) saveSettingsDebounced();
    updateCacheStatsUI();

    // The language is part of every cache key and is read again when a result
    // arrives, so it cannot change while a translation is running (the reply
    // would be stored under the new language).
    const langBusy = () => {
        if (!isBusy) return false;
        if (typeof toastr !== 'undefined') toastr.warning('번역이 끝난 뒤에 번역 언어를 바꿔 주세요');
        return true;
    };
    $('#pt-target-lang').on('change',function(){
        if (langBusy()) { this.value = cfg().targetLang; return; }
        cfg().targetLang=this.value;
        saveSettingsDebounced();
        const isCustom = this.value === '__custom__';
        $('#pt-custom-lang-row').toggle(isCustom);
        $('#pt-custom-lang-hint').toggle(isCustom);
    });
    $('#pt-custom-lang').on('input',function(){ if (langBusy()) { this.value = cfg().customLang || ''; return; } cfg().customLang=this.value;saveSettingsDebounced();});
    $('#pt-title-batch').on('change',function(){
        let v = parseInt(this.value,10);
        if (isNaN(v) || v < 1) v = 1;
        if (v > 50) v = 50;
        this.value = v;
        cfg().titleBatchSize = v; saveSettingsDebounced();
    });
    $('#pt-req-delay').on('change',function(){
        let v = parseInt(this.value,10);
        if (isNaN(v) || v < 0) v = 0;
        if (v > 60000) v = 60000;
        this.value = v;
        cfg().requestDelayMs = v; saveSettingsDebounced();
    });
    $('#pt-theme').on('change',function(){cfg().theme=this.value;saveSettingsDebounced();const p=PDOC.getElementById('pt-panel');if(p)p.setAttribute('data-pt-theme',this.value);});
    $('#pt-orig-size').on('input', function(){
        const v = parseInt(this.value, 10) || 11;
        cfg().originalFontSize = v;
        saveSettingsDebounced();
        const label = document.getElementById('pt-orig-size-val');
        if (label) label.textContent = v + 'px';
        applyFontSizes();
    });
    $('#pt-trans-size').on('input', function(){
        const v = parseInt(this.value, 10) || 12;
        cfg().translatedFontSize = v;
        saveSettingsDebounced();
        const label = document.getElementById('pt-trans-size-val');
        if (label) label.textContent = v + 'px';
        applyFontSizes();
    });
    // Connection settings. All of these elements are part of the settings block built above.
    $('#pt-provider').on('change', function () {
        const c = cfg();
        c.provider = this.value;
        c.model = serviceRow(this.value).models[0] || MODEL_TYPED;   // nothing to suggest: the name is typed in
        saveSettingsDebounced(); showModelBox(true); showKnobs(); updateStatusModel();
    });
    $('#pt-model-select').on('change', function () { cfg().model = this.value; saveSettingsDebounced(); showModelBox(); showKnobNote(); updateStatusModel(); });
    $('#pt-model-custom').on('input', function () { cfg().customModelName = this.value; saveSettingsDebounced(); showKnobNote(); updateStatusModel(); });
    $('#pt-params-wrap')
        .on('input', 'input[data-pkey]', function () {
            const v = parseFloat(this.value);
            if (!isFinite(v)) return;            // box emptied while typing: the last value stays
            savedKnobs()[this.dataset.pkey] = v;
            $(this).siblings('input[data-pkey]').val(v);
            saveSettingsDebounced();
        })
        .on('change', 'input[data-pkey]', function () { this.value = knob(savedKnobs(), this.dataset.pkey); })
        .on('click', '#pt-params-reset', () => { delete cfg().parameters[cfg().provider]; saveSettingsDebounced(); showKnobs(); });
    $('#pt-custom-url')
        .on('input', function () { cfg().customUrl = this.value; saveSettingsDebounced(); showKeyHint(); })
        .on('change', function () {   // show the address as it will be used; models listed for another address no longer apply
            cfg().customUrl = this.value = customUrl(); saveSettingsDebounced();
            customModels = []; document.getElementById('pt-custom-msg').textContent = ''; showModelBox(true);
        });
    customKeyReady.then(() => { const el = document.getElementById('pt-custom-key'); if (el) el.value = customKey; });
    $('#pt-custom-key')
        .on('input', function () { customKey = this.value.trim(); document.getElementById('pt-custom-msg').textContent = ''; })   // "연결됨" was about the previous key
        .on('change', function () {
            (customKey ? metaPut(CUSTOM_KEY, customKey) : metaDelete(CUSTOM_KEY)).catch(e => {
                console.warn(`[${EXT}] custom endpoint key not saved`, e);
                if (typeof toastr !== 'undefined') toastr.warning('API 키를 이 기기에 저장하지 못했어요. 지금은 쓸 수 있지만 새로고침하면 다시 입력해야 합니다.');
            });
        });
    $('#pt-custom-models').on('click', async function () {
        const msg = document.getElementById('pt-custom-msg');
        const asked = () => cfg().provider + '\n' + customUrl() + '\n' + customKey, was = asked();
        this.disabled = true;
        msg.textContent = '불러오는 중...';
        let got = null, failed = '';
        try { got = await fetchCustomModels(); } catch (e) { failed = String(e?.message || e).slice(0, 240); }
        this.disabled = false;
        if (asked() !== was) {   // service, address or key changed meanwhile: the answer is about something else
            if (msg.textContent === '불러오는 중...') msg.textContent = '';
            return;
        }
        customModels = got ? got.names : [];
        msg.textContent = got ? `연결됨 · 모델 ${customModels.length}개 · ${got.keyUsed} (아래 모델 칸에서 선택)` : failed;
        showModelBox(true);
    });
    $('#pt-use-proxy').on('change', function () { cfg().useReverseProxy = this.checked; saveSettingsDebounced(); $('#pt-proxy-wrap').toggle(this.checked); });
    $('#pt-proxy-url').on('input', function () { cfg().reverseProxyUrl = this.value; saveSettingsDebounced(); });
    $('#pt-proxy-pw').on('input', function () { cfg().reverseProxyPassword = this.value; saveSettingsDebounced(); });
    $('#pt-prefill-toggle').on('change', function () { cfg().prefillEnabled = this.checked; saveSettingsDebounced(); });
    $('#pt-prefill-text')
        .on('input', function () { cfg().prefillText = this.value; saveSettingsDebounced(); })
        .on('change', function () { this.value = cfg().prefillText; });   // emptied: show the default that will be sent
    $('#pt-fab-toggle').on('change',function(){
        cfg().fabVisible=this.checked;saveSettingsDebounced();
        if(this.checked){if(!PDOC.getElementById('pt-fab'))buildFab();}
        else PDOC.getElementById('pt-fab')?.remove();
    });
    $('#pt-open-panel-btn').on('click', () => openPanel());

    // ── Preset glossary editor ──
    const refreshGlossaryCount = () => {
        const n = parseGlossary($('#pt-glossary').val()).length;
        $('#pt-glossary-count').text(`${n}개 항목`);
    };
    try { await glossaryReady; } catch (e) {}
    $('#pt-glossary').val(glossaryText);
    refreshGlossaryCount();
    $('#pt-glossary').on('input', refreshGlossaryCount);

    const saveGlossary = async (text) => {
        // Saving text identical to the built-in list stores nothing, so users who
        // never customised keep receiving built-in updates in future versions.
        try {
            if (text === DEFAULT_GLOSSARY) await metaDelete(GLOSSARY_KEY);
            else await metaPut(GLOSSARY_KEY, text);
            glossaryText = text;
            return true;
        } catch (e) {
            console.warn(`[${EXT}] glossary save failed`, e);
            glossaryText = text;   // still applies for this session
            return false;
        }
    };
    $('#pt-glossary-save').on('click', async () => {
        const text = String($('#pt-glossary').val() ?? '');
        const ok = await saveGlossary(text);
        if (typeof toastr === 'undefined') return;
        if (ok) toastr.success(`용어집 저장됨 (${parseGlossary(text).length}개 항목)`);
        else toastr.warning('용어집을 저장하지 못했습니다. 이번 세션에만 적용됩니다.');
    });
    $('#pt-glossary-reset').on('click', async () => {
        if (!confirm('용어집을 기본 목록으로 되돌릴까요?\n\n직접 추가하거나 고친 항목은 사라집니다.')) return;
        $('#pt-glossary').val(DEFAULT_GLOSSARY);
        refreshGlossaryCount();
        const ok = await saveGlossary(DEFAULT_GLOSSARY);
        if (typeof toastr !== 'undefined') {
            ok ? toastr.success('기본 용어집으로 되돌렸습니다') : toastr.warning('저장하지 못했습니다. 이번 세션에만 적용됩니다.');
        }
    });
    $('#pt-cache-export-btn').on('click', () => {
        exportCacheBackup($('#pt-cache-with-orig').prop('checked')).catch(e => {
            console.error(`[${EXT}] backup failed`, e);
            if (typeof toastr !== 'undefined') toastr.error('백업 중 오류가 발생했습니다');
        });
    });
    // Preserved originals: count, list with delete, auto option
    const origStatsUI = () => {
        const list = ORIG_INDEX || [];
        const bytes = list.reduce((n, e) => n + (e.size || 0), 0);
        $('#pt-orig-stats').text(list.length ? `${list.length}개 · ${fmtBytes(bytes)}` : '없음');
        $('#pt-cache-with-orig-row').toggle(list.length > 0);
        const box = document.getElementById('pt-orig-list');
        if (box && box.style.display !== 'none') origListUI();
    };
    const origListUI = () => {
        const box = document.getElementById('pt-orig-list');
        if (!box) return;
        const list = ORIG_INDEX || [];
        box.innerHTML = list.length ? list.map(e => {
            const missing = !isInstalledPreset(e.name);
            return `<div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--SmartThemeBorderColor,#8884);font-size:12px;">
                <div style="flex:1;min-width:0;"><div style="overflow-wrap:anywhere;">${esc(e.name)}</div>
                <small style="opacity:.7;">${fmtDay(e.savedAt)} · ${fmtBytes(e.size || 0)} · ${esc(ORIG_SOURCE_LABEL[e.source] || '')}${missing ? ' · 실리태번에 없음' : ''}</small></div>
                <button type="button" class="menu_button pt-orig-del" data-name="${esc(e.name)}" title="삭제" aria-label="${esc(e.name)} 보존본 삭제" style="flex:0 0 auto;margin:0;padding:4px 8px;"><i class="fa-solid fa-trash"></i></button>
            </div>`;
        }).join('') : '<small style="opacity:.7;">보존된 원본이 없습니다. 프리셋 탭에서 📥 원본 보존을 누르세요.</small>';
    };
    ORIG_LISTENERS.add(origStatsUI);
    origIndexLoad().then(origStatsUI);
    $('#pt-orig-list-btn').on('click', () => {
        const box = document.getElementById('pt-orig-list');
        if (!box) return;
        const open = box.style.display === 'none';
        box.style.display = open ? '' : 'none';
        if (open) origListUI();
    });
    $('#pt-orig-list').on('click', '.pt-orig-del', async function () {
        const name = this.dataset.name;
        if (!name || !confirm(`'${name}' 보존본을 삭제할까요?\n\n되돌릴 수 없습니다. 실리태번의 프리셋은 그대로입니다.`)) return;
        try { await origDelete(name); if (typeof toastr !== 'undefined') toastr.success('보존본을 삭제했습니다'); }
        catch (e) { console.warn(`[${EXT}] delete original`, e); if (typeof toastr !== 'undefined') toastr.error('삭제하지 못했습니다'); }
    });
    $('#pt-orig-auto').on('change', function () { cfg().autoPreserveImport = !!this.checked; saveSettingsDebounced(); });
    // Folding sections open at once. ST's own inline-drawer handler (a click
    // listener on the whole document) slides a section open over about 0.4 s,
    // re-laying out the page on every frame. Stopping the click here keeps it
    // away from that handler; the classes stay, so ST's look is unchanged.
    // The outer "Prompt Panel" drawer keeps ST's behaviour, like any extension.
    $('.pt-extension-settings .pt-ext-sec > .inline-drawer-header').on('click', function (e) {
        e.stopPropagation();
        const content = this.parentElement.querySelector(':scope > .inline-drawer-content');
        if (!content) return;
        const open = getComputedStyle(content).display !== 'none';
        content.style.display = open ? 'none' : 'block';
        const icon = this.querySelector('.inline-drawer-icon');
        if (icon) {
            icon.classList.toggle('down', open);
            icon.classList.toggle('up', !open);
            icon.classList.toggle('fa-circle-chevron-down', open);
            icon.classList.toggle('fa-circle-chevron-up', !open);
        }
    });
    // ⓘ buttons: show/hide the help text they point at
    $('.pt-extension-settings .pt-info-btn').on('click keydown', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();          // ⓘ sits in a section header: it must not fold the section
        const info = $('#' + this.dataset.info);
        const sec = this.closest('.pt-ext-sec');
        const content = sec && sec.querySelector(':scope > .inline-drawer-content');
        if (content && getComputedStyle(content).display === 'none') {
            info.show();              // closed section: open it with the help showing
            sec.querySelector(':scope > .inline-drawer-header')?.click();
        } else info.toggle();
    });

    // Ask settings
    const numSetting = (sel, key, min, max, fallback) => $(sel).on('change', function () {
        let v = parseFloat(this.value);
        if (!isFinite(v)) v = fallback;
        v = Math.min(max, Math.max(min, v));
        this.value = v;
        cfg()[key] = v; saveSettingsDebounced();
    });
    numSetting('#pt-ask-budget', 'askBudget', 1000, 2000000, 60000);
    numSetting('#pt-ask-maxtok', 'askMaxTokens', 0, 200000, 0);
    $('#pt-ask-temp').on('change', function () {
        const raw = String(this.value).trim();
        if (raw === '') { cfg().askTemperature = null; saveSettingsDebounced(); return; }
        let v = parseFloat(raw);
        if (!isFinite(v)) { this.value = ''; cfg().askTemperature = null; saveSettingsDebounced(); return; }
        v = Math.min(2, Math.max(0, v));
        this.value = v;
        cfg().askTemperature = v; saveSettingsDebounced();
    });
    $('#pt-cache-import-btn').on('click', () => $('#pt-cache-import-file').trigger('click'));
    $('#pt-cache-import-file').on('change', async function () {
        const file = this.files && this.files[0];
        this.value = '';   // allow picking the same file again later
        try { await importCacheBackup(file); }
        catch (e) {
            console.error(`[${EXT}] backup import failed`, e);
            if (typeof toastr !== 'undefined') toastr.error('가져오기 중 오류가 발생했습니다');
        }
    });

    $('#pt-clear-cache-btn').on('click', async () => {
        const { count, sizeStr } = getCacheStats();
        if (count === 0) {
            if (typeof toastr !== 'undefined') toastr.info('삭제할 번역 캐시가 없습니다');
            return;
        }
        const msg = `⚠️ 번역 데이터가 전부 삭제됩니다.\n\n현재 저장된 번역: ${count}개 (${sizeStr})\n\n이 작업은 되돌릴 수 없습니다. 필요하면 먼저 '백업'으로 파일을 받아두세요.\n정말 삭제할까요?`;
        if (!confirm(msg)) return;
        translationMap.clear();
        await dbClear();
        if (typeof toastr !== 'undefined') toastr.success(`번역 캐시 ${count}개가 삭제되었습니다`);
        updateCacheStatsUI();
    });

    buildPanel();
    showKnobs();

    function tryFab(n){
        if(!cfg().fabVisible||PDOC.getElementById('pt-fab'))return;
        if(PDOC.body)buildFab();
        else if(n<30)setTimeout(()=>tryFab(n+1),300);
    }
    if(event_types?.APP_READY)eventSource.once(event_types.APP_READY,()=>tryFab(0));
    // Option (off by default): keep a copy of presets imported through ST.
    // With the option off the listener returns at once.
    try { if (event_types?.OAI_PRESET_IMPORT_READY) eventSource.on(event_types.OAI_PRESET_IMPORT_READY, onPresetImportReady); } catch (e) {}
    setTimeout(()=>tryFab(0),600);
    setTimeout(()=>tryFab(0),2000);

    console.log(`[${EXT}] loaded`);
});
