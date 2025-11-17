
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const Imap = require('imap-simple');
const { simpleParser } = require('mailparser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

const authenticate = (req, res, next) => {
    const authHeader = req.headers['x-proxy-secret'];
    if (!PROXY_SECRET) {
        console.warn("WARNING: PROXY_SECRET is not set.");
    } else if (authHeader !== PROXY_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized Proxy Access' });
    }
    next();
};

// Helper to find the best part to fetch (HTML > Plain)
const findBestPart = (parts) => {
    if (!parts) return null;
    // Flatten nested parts if necessary (simple recursion for this specific structure)
    const flatParts = [];
    const traverse = (p) => {
        p.forEach(part => {
            flatParts.push(part);
            if (part.parts) traverse(part.parts);
        });
    };
    traverse(parts);

    // 1. Prefer HTML
    const htmlPart = flatParts.find(p => p.type === 'text' && p.subtype === 'html');
    if (htmlPart) return htmlPart;

    // 2. Fallback to Plain Text
    const textPart = flatParts.find(p => p.type === 'text' && p.subtype === 'plain');
    if (textPart) return textPart;

    return null;
};

app.post('/fetch', authenticate, async (req, res) => {
    const { config, searchCriteria, limit } = req.body;
    let connection = null;

    if (!config || !config.imap) {
        return res.status(400).json({ success: false, error: 'Missing IMAP configuration' });
    }

    try {
        console.log(`[Proxy] Connecting to ${config.imap.host}...`);
        connection = await Imap.connect(config);
        await connection.openBox('INBOX');

        // 1. SEARCH & FETCH STRUCTURE ONLY
        // FIX: 'struct: true' fetches BODYSTRUCTURE. 'bodies' should only contain 'HEADER'.
        // Putting 'BODYSTRUCTURE' in bodies results in invalid IMAP 'BODY[BODYSTRUCTURE]'.
        const fetchOptions = {
            bodies: ['HEADER'],
            struct: true, 
            markSeen: false
        };
        
        const criteria = searchCriteria || [['ALL']];
        console.log(`[Proxy] Searching with criteria: ${JSON.stringify(criteria)}`);
        
        // Fetch metadata first
        let searchResults = await connection.search(criteria, fetchOptions);
        
        // Sort: Newest First.
        searchResults.reverse();

        // Apply LIMIT *before* heavy fetching
        if (limit && searchResults.length > limit) {
            searchResults = searchResults.slice(0, limit);
        }

        console.log(`[Proxy] Processing top ${searchResults.length} messages...`);

        const processedMessages = [];

        // 2. FETCH ACTUAL BODIES (SEQUENTIAL TO AVOID RATE LIMITS)
        for (const item of searchResults) {
            try {
                const uid = item.attributes.uid;
                
                // Extract Header Info
                const headerPart = item.parts.find(p => p.which === 'HEADER');
                const headers = headerPart?.body || {};
                
                const subject = headers.subject ? headers.subject[0] : '(No Subject)';
                const from = headers.from ? headers.from[0] : '(Unknown)';
                const date = headers.date ? headers.date[0] : new Date().toISOString();
                const messageId = headers['message-id'] ? headers['message-id'][0] : null;

                let bodyText = "";
                let bodyHtml = "";
                let partData = null;

                // Attempt to find best part ID from structure (attributes.struct is populated due to struct: true)
                const bestPart = findBestPart(item.attributes.struct);
                
                if (bestPart && bestPart.partID) {
                    // Fetch specific part (e.g., '1.2')
                    partData = await connection.getPartData(item, bestPart);
                } else {
                    // Fallback: Fetch 'TEXT' (standard body)
                    try {
                        partData = await connection.getPartData(item, { partID: 'TEXT', type: 'text', subtype: 'plain' });
                    } catch (e) {
                        try {
                             partData = await connection.getPartData(item, { partID: '1', type: 'text', subtype: 'plain' });
                        } catch (e2) {
                            console.warn(`[Proxy] Could not fetch body for UID ${uid}`);
                        }
                    }
                }

                if (partData) {
                    // Parse using mailparser to handle encoding/charset
                    const parsed = await simpleParser(typeof partData === 'string' ? partData : Buffer.from(partData));
                    bodyText = parsed.text; 
                    bodyHtml = parsed.html || parsed.textAsHtml;
                }

                processedMessages.push({
                    uid,
                    messageId,
                    subject,
                    from,
                    date,
                    bodyText: bodyText || "",
                    bodyHtml: bodyHtml || ""
                });

            } catch (msgErr) {
                console.error(`[Proxy] Error processing message ${item.attributes.uid}:`, msgErr.message);
            }
        }

        res.json({
            success: true,
            messages: processedMessages,
            count: processedMessages.length
        });

    } catch (err) {
        console.error('[Proxy] Error:', err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (connection) {
            try { connection.end(); } catch(e) {}
        }
    }
});

app.listen(PORT, () => {
    console.log(`IMAP Proxy Server running on port ${PORT}`);
});
