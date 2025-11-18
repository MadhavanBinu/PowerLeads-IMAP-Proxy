
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const Imap = require('imap-simple');
const { simpleParser } = require('mailparser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET;

// Prevent process from crashing on unhandled errors
process.on('uncaughtException', (err) => {
    console.error('[Proxy] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Proxy] Unhandled Rejection at:', promise, 'reason:', reason);
});

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

// Helper to safely traverse email structure and find best part
const findBestPart = (struct) => {
    if (!struct) return null;
    const flatParts = [];
    
    const traverse = (p) => {
        if (Array.isArray(p)) {
            p.forEach(part => {
                flatParts.push(part);
                if (part.parts) traverse(part.parts);
            });
        } else if (typeof p === 'object' && p !== null) {
             flatParts.push(p);
             if (p.parts) traverse(p.parts);
        }
    };

    try {
        traverse(struct);
    } catch (e) {
        console.error("Error traversing structure:", e);
        return null;
    }

    // 1. Prefer HTML
    const htmlPart = flatParts.find(p => p.type === 'text' && p.subtype === 'html');
    if (htmlPart) return htmlPart;

    // 2. Fallback to Plain Text
    const textPart = flatParts.find(p => p.type === 'text' && p.subtype === 'plain');
    if (textPart) return textPart;

    return null;
};

// Wrapper to fetch part data with a strict timeout
const getPartDataWithTimeout = (connection, item, part, timeoutMs = 5000) => {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error("Body fetch timeout"));
        }, timeoutMs);

        connection.getPartData(item, part)
            .then(data => {
                clearTimeout(timer);
                resolve(data);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
};

app.post('/fetch', authenticate, async (req, res) => {
    const { config, searchCriteria, limit, fetchBodies } = req.body;
    let connection = null;
    const shouldFetchBodies = fetchBodies !== false; // Default to true

    if (!config || !config.imap) {
        return res.status(400).json({ success: false, error: 'Missing IMAP configuration' });
    }

    try {
        console.log(`[Proxy] Connecting to ${config.imap.host}...`);
        connection = await Imap.connect(config);
        await connection.openBox('INBOX');

        const fetchOptions = {
            bodies: ['HEADER'],
            struct: shouldFetchBodies, 
            markSeen: false
        };
        
        const criteria = searchCriteria || [['ALL']];
        console.log(`[Proxy] Searching... (Bodies: ${shouldFetchBodies})`);
        
        let searchResults = await connection.search(criteria, fetchOptions);
        
        // Sort: Newest First.
        searchResults.reverse();

        // Apply LIMIT
        if (limit && searchResults.length > limit) {
            searchResults = searchResults.slice(0, limit);
        }

        console.log(`[Proxy] Processing ${searchResults.length} messages...`);

        const processedMessages = [];

        for (const item of searchResults) {
            try {
                const uid = item.attributes?.uid || 0;
                const headerPart = item.parts.find(p => p.which === 'HEADER');
                const headers = headerPart?.body || {};
                
                const subject = headers.subject ? headers.subject[0] : '(No Subject)';
                const from = headers.from ? headers.from[0] : '(Unknown)';
                const date = headers.date ? headers.date[0] : new Date().toISOString();
                const messageId = headers['message-id'] ? headers['message-id'][0] : null;

                let bodyText = "";
                let bodyHtml = "";

                // Only attempt body fetching if requested
                if (shouldFetchBodies) {
                    let partData = null;
                    let fetchError = null;

                    if (item.attributes && item.attributes.struct) {
                         const bestPart = findBestPart(item.attributes.struct);
                         if (bestPart && bestPart.partID) {
                            try {
                                partData = await getPartDataWithTimeout(connection, item, bestPart, 5000); // 5s timeout
                            } catch (err) {
                                console.warn(`[Proxy] Failed to fetch part for UID ${uid}:`, err.message);
                                fetchError = err.message;
                            }
                         }
                    }

                    // Fallback if structure parsing failed or returned nothing, OR if first attempt failed
                    if (!partData && !fetchError) {
                        try {
                            // Try fetching default text part
                            partData = await getPartDataWithTimeout(connection, item, { partID: '1', type: 'text', subtype: 'plain' }, 5000);
                        } catch (e) {
                            console.warn(`[Proxy] Failed to fetch fallback part for UID ${uid}: ${e.message}`);
                        }
                    }

                    if (partData) {
                        try {
                            const parsed = await simpleParser(typeof partData === 'string' ? partData : Buffer.from(partData));
                            bodyText = parsed.text; 
                            bodyHtml = parsed.html || parsed.textAsHtml;
                        } catch (parseErr) {
                            console.error(`[Proxy] Parsing error for UID ${uid}:`, parseErr.message);
                            bodyText = "(Parsing Failed)";
                        }
                    } else {
                        bodyText = "[Content could not be fetched automatically. Please check mail server.]";
                    }
                } else {
                    bodyText = "[No Text Body]";
                    bodyHtml = "(No HTML)";
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
                console.error(`[Proxy] Error processing message loop:`, msgErr.message);
                // Continue to next message instead of crashing
            }
        }

        res.json({
            success: true,
            messages: processedMessages,
            count: processedMessages.length
        });

    } catch (err) {
        console.error('[Proxy] Critical Error:', err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message });
        }
    } finally {
        if (connection) {
            try { connection.end(); } catch(e) {}
        }
    }
});

app.listen(PORT, () => {
    console.log(`IMAP Proxy Server running on port ${PORT}`);
});
