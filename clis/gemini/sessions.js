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
    description: 'List all Gemini conversation sessions, or sessions within a specific notebook',
    domain: GEMINI_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: true,
    args: [
        { name: 'limit', type: 'int', required: false, help: 'Max number of sessions to return (default: 20)', default: 20 },
        { name: 'notebook', required: false, help: 'Notebook ID or Title to list sessions for', default: '' },
    ],
    columns: ['SessionID', 'Type', 'Title', 'URL'],
    func: async (page, kwargs) => {
        const limit = kwargs.limit || 20;
        const notebookQuery = String(kwargs.notebook || '').trim();

        if (notebookQuery) {
            let notebookUrl = '';
            let notebookTitle = '';
            
            // Check if notebookQuery is a valid UUID
            if (/^[a-f0-9-]{36}$/i.test(notebookQuery)) {
                notebookUrl = `https://gemini.google.com/notebook/${notebookQuery}`;
                notebookTitle = `Notebook (${notebookQuery})`;
            } else {
                // Fetch list first to find notebook by title
                const conversations = await getGeminiConversationList(page, true);
                const matched = conversations.find(c => 
                    c.Url.includes('/notebook/') && 
                    c.Title.toLowerCase().includes(notebookQuery.toLowerCase())
                );
                if (matched) {
                    notebookUrl = matched.Url;
                    notebookTitle = matched.Title;
                }
            }

            if (!notebookUrl) {
                return [{ 
                    SessionID: '-', 
                    Type: 'Error', 
                    Title: `Notebook "${notebookQuery}" not found.`, 
                    URL: '-' 
                }];
            }

            // Navigate to Notebook page
            await page.goto(notebookUrl, { waitUntil: 'load', settleMs: 3000 });
            await page.wait(2.0); // Wait for the page chats list to render



            // Extract inner chats inside the notebook from PROJECT-CHAT-ROW elements
            const innerChats = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('PROJECT-CHAT-ROW'));
                const list = [];
                
                // Helper to search an object recursively for 16-character hex strings
                const findSessionId = (obj, depth = 0, seen = new Set()) => {
                    if (depth > 4 || !obj || typeof obj !== 'object' || seen.has(obj)) return '';
                    seen.add(obj);
                    
                    for (const key in obj) {
                        try {
                            const val = obj[key];
                            if (typeof val === 'string' && /^[a-f0-9]{16}$/i.test(val)) {
                                return val;
                            }
                            if (typeof val === 'object' && val !== null) {
                                const found = findSessionId(val, depth + 1, seen);
                                if (found) return found;
                            }
                        } catch (e) {}
                    }
                    return '';
                };

                for (const row of rows) {
                    const titleEl = row.querySelector('.chat-title');
                    const title = titleEl?.textContent?.trim() || '';
                    if (!title) continue;

                    // Search row properties (like Angular's __ngContext__) for a session ID
                    let sessionId = '';
                    try {
                        for (const key of Object.keys(row)) {
                            if (key.startsWith('__ng') || key === 'context') {
                                sessionId = findSessionId(row[key]);
                                if (sessionId) break;
                            }
                        }
                        if (!sessionId) {
                            sessionId = findSessionId(row);
                        }
                    } catch (e) {}

                    list.push({
                        SessionID: sessionId || 'N/A (Click by Title)',
                        Type: 'NotebookChat',
                        Title: title,
                        URL: window.location.href
                    });
                }
                return list;
            });

            if (!innerChats || innerChats.length === 0) {
                return [{ 
                    SessionID: '-', 
                    Type: 'Empty', 
                    Title: `No sessions found inside Notebook "${notebookTitle}"`, 
                    URL: notebookUrl 
                }];
            }

            return innerChats.slice(0, limit);
        }

        // Standard mode: list recent sidebar conversations and notebooks
        const conversations = await getGeminiConversationList(page, true);
        
        if (!conversations || conversations.length === 0) {
            return [{ SessionID: '-', Type: '-', Title: 'No sessions found', URL: '-' }];
        }

        // Format session info
        const results = conversations
            .slice(0, limit)
            .map(conv => {
                const isNotebook = conv.Url.includes('/notebook/');
                return {
                    SessionID: extractSessionId(conv.Url) || 'N/A',
                    Type: isNotebook ? 'Notebook' : 'Chat',
                    Title: conv.Title.slice(0, 60) + (conv.Title.length > 60 ? '...' : ''),
                    URL: conv.Url,
                };
            });

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
        const conversations = await getGeminiConversationList(page, true);
        
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
            // Fallback: Attempt to click directly in the current page DOM (e.g. if we are currently on a notebook page)
            const clickedDirectly = await clickGeminiConversationByTitle(page, title);
            if (clickedDirectly) {
                await page.wait(1);
                const currentUrl = await page.evaluate('window.location.href');
                return [{ 
                    Status: 'opened', 
                    SessionID: extractSessionId(currentUrl), 
                    URL: currentUrl 
                }];
            }
            
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
