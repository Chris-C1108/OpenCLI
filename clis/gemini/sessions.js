// ============ sessions.js - 新文件 ============
import { cli, Strategy } from '@jackwener/opencli/registry';
import { GEMINI_DOMAIN, getGeminiConversationList, clickGeminiConversationByTitle } from './utils.js';

/**
 * 从 URL 中提取 session ID
 */
function extractSessionId(url) {
    const match = url.match(/\/app\/([a-f0-9]{16})/i) || url.match(/\/notebook\/([a-f0-9-]+)/i);
    return match ? match[1] : '';
}

/**
 * 列出所有历史会话
 */
export const sessionsCommand = cli({
    site: 'gemini',
    name: 'sessions',
    access: 'read',
    description: 'List all Gemini conversation sessions',
    domain: GEMINI_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: true,
    args: [
        { name: 'limit', type: 'int', required: false, help: 'Max number of sessions to return (default: 20)', default: 20 },
    ],
    columns: ['SessionID', 'Title', 'URL'],
    func: async (page, kwargs) => {
        const limit = kwargs.limit || 20;
        
        // 获取会话列表
        const conversations = await getGeminiConversationList(page);
        
        if (!conversations || conversations.length === 0) {
            return [{ SessionID: '-', Title: 'No sessions found', URL: '-' }];
        }

        // 提取并格式化会话信息
        const results = conversations
            .slice(0, limit)
            .map(conv => ({
                SessionID: extractSessionId(conv.Url) || 'N/A',
                Title: conv.Title.slice(0, 60) + (conv.Title.length > 60 ? '...' : ''),
                URL: conv.Url,
            }));

        return results;
    },
});

/**
 * 通过标题选择并打开会话
 */
export const selectSessionCommand = cli({
    site: 'gemini',
    name: 'select-session',
    access: 'write',
    description: 'Select and open a Gemini conversation by title',
    domain: GEMINI_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: true,
    args: [
        { name: 'title', positional: true, required: true, help: 'Conversation title to search for' },
        { name: 'exact', type: 'boolean', required: false, help: 'Use exact match instead of contains', default: false },
    ],
    columns: ['Status', 'SessionID', 'URL'],
    func: async (page, kwargs) => {
        const title = kwargs.title;
        const exactMatch = kwargs.exact;

        // 获取所有会话
        const conversations = await getGeminiConversationList(page);
        
        if (!conversations || conversations.length === 0) {
            return [{ Status: 'error', SessionID: '-', URL: 'No sessions found' }];
        }

        // 查找匹配的会话
        const normalizeTitle = (t) => t.toLowerCase().trim();
        const searchTitle = normalizeTitle(title);
        
        let matched = null;
        if (exactMatch) {
            matched = conversations.find(c => normalizeTitle(c.Title) === searchTitle);
        } else {
            matched = conversations.find(c => normalizeTitle(c.Title).includes(searchTitle));
        }

        if (!matched) {
            return [{ 
                Status: 'not-found', 
                SessionID: '-', 
                URL: `No session matching "${title}"` 
            }];
        }

        // 点击打开会话
        const clicked = await clickGeminiConversationByTitle(page, matched.Title);
        
        if (!clicked) {
            return [{ 
                Status: 'click-failed', 
                SessionID: extractSessionId(matched.Url), 
                URL: matched.Url 
            }];
        }

        await page.wait(1);
        const currentUrl = await page.evaluate('window.location.href');

        return [{ 
            Status: 'opened', 
            SessionID: extractSessionId(currentUrl), 
            URL: currentUrl 
        }];
    },
});
