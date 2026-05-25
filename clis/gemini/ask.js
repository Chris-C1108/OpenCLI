import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { GEMINI_DOMAIN, readGeminiSnapshot, sendGeminiMessage, startNewGeminiChat, waitForGeminiResponse, waitForGeminiSubmission, setGeminiSessionAnchor, selectGeminiModel } from './utils.js';

function normalizeBooleanFlag(value) {
    if (typeof value === 'boolean')
        return value;
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

const NO_RESPONSE_PREFIX = '[NO RESPONSE]';

export const askCommand = cli({
    site: 'gemini',
    name: 'ask',
    access: 'write',
    description: 'Send a prompt to Gemini and return only the assistant response',
    domain: GEMINI_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: false, // 必须为 false，防止原厂机制在未指定路由时默认开荒
    defaultFormat: 'plain',
    args: [
        { name: 'prompt', required: true, positional: true, help: 'Prompt to send' },
        { name: 'timeout', type: 'int', required: false, help: 'Max seconds to wait (default: 60)', default: 60 },
        { name: 'new', required: false, help: 'Start a new chat first (true/false, default: false)', default: 'false' },
        { name: 'session', required: false, help: 'Resume a specific conversation by session ID (16-char hex)', default: '' },
        { name: 'model', required: false, help: 'Gemini model to use (gemini-2.0-flash-exp, gemini-1.5-pro, etc.)', default: '' },
    ],
    columns: ['response'],
    func: async (page, kwargs) => {
        const prompt = kwargs.prompt;
        const timeout = kwargs.timeout;
        const sessionId = String(kwargs.session || '').trim();
        
        if (!Number.isInteger(timeout) || timeout < 1) {
            throw new ArgumentError('--timeout must be a positive integer (seconds)');
        }

        if (sessionId) {
            if (!/^[a-f0-9]{16}$/i.test(sessionId)) {
                throw new ArgumentError('--session must be a 16-character hexadecimal string');
            }
            setGeminiSessionAnchor(sessionId);
            const targetUrl = `https://gemini.google.com/app/${sessionId}`;
            await page.goto(targetUrl, { waitUntil: 'load', settleMs: 3000 });
            await page.wait(1.5);
        } else {
            setGeminiSessionAnchor(null);
            const startFresh = normalizeBooleanFlag(kwargs.new);
            if (startFresh)
                await startNewGeminiChat(page);
        }

        const modelKey = String(kwargs.model || '').trim();
        if (modelKey) {
            const result = await selectGeminiModel(page, modelKey);
            if (!result.success) {
                throw new ArgumentError(`Failed to select model: ${result.reason}`);
            }
        }

        const before = await readGeminiSnapshot(page);
        await sendGeminiMessage(page, prompt);
        const submissionStartedAt = Date.now();
        const submitted = await waitForGeminiSubmission(page, before, timeout);
        if (!submitted) {
            return [{ response: `💬 ${NO_RESPONSE_PREFIX} No Gemini response within ${timeout}s.` }];
        }
        const remainingTimeoutSeconds = Math.max(0, timeout - Math.ceil((Date.now() - submissionStartedAt) / 1000));
        const response = await waitForGeminiResponse(page, submitted, prompt, remainingTimeoutSeconds);
        if (!response) {
            return [{ response: `💬 ${NO_RESPONSE_PREFIX} No Gemini response within ${timeout}s.` }];
        }
        return [{ response: `💬 ${response}` }];
    },
});