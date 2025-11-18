
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
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

app.post('/fetch', authenticate, async (req, res) => {
    const { config, limit = 5, fetchBodies = true } = req.body;

    if (!config || !config.imap) {
        return res.status(400).json({ success: false, error: 'Missing IMAP configuration' });
    }

    const client = new ImapFlow({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.tls,
        auth: {
            user: config.imap.user,
            pass: config.imap.password
        },
        logger: false, // Disable internal logger to keep logs clean
        tls: { rejectUnauthorized: false } // Allow self-signed certs if needed
    });

    try {
        console.log(`[Proxy] Connecting to ${config.imap.host}...`);
        await client.connect();
        
        // Open INBOX
        const lock = await client.getMailboxLock('INBOX');
        
        try {
            // 1. Get mailbox status to find total message count
            // This is much faster than searching for everything
            const status = await client.status('INBOX', { messages: true });
            const totalMessages = status.messages;

            console.log(`[Proxy] Inbox has ${totalMessages} messages.`);

            if (totalMessages === 0) {
                return res.json({ success: true, messages: [], count: 0 });
            }

            // 2. Calculate range for the latest 'limit' messages
            // IMAP sequence numbers start at 1. Oldest is 1, Newest is 'total'.
            // To get top 5: range is (total - 5 + 1) : total
            const startIndex = Math.max(1, totalMessages - limit + 1);
            const range = `${startIndex}:${totalMessages}`;
            
            console.log(`[Proxy] Fetching range: ${range} (fetchBodies: ${fetchBodies})`);

            const messages = [];

            // 3. Fetch messages
            // We request 'source' to get the raw email, which mailparser handles best.
            // We also get 'envelope' for quick metadata.
            const fetchOptions = {
                uid: true,
                envelope: true,
                source: fetchBodies // Only download full body if requested
            };

            for await (const message of client.fetch(range, fetchOptions)) {
                const msgData = {
                    uid: message.uid,
                    messageId: message.envelope.messageId,
                    subject: message.envelope.subject || '(No Subject)',
                    from: message.envelope.from ? message.envelope.from.map(f => f.address || f.name).join(', ') : '',
                    date: message.envelope.date ? message.envelope.date.toISOString() : new Date().toISOString(),
                    bodyText: '[No Body]',
                    bodyHtml: '',
                };

                if (fetchBodies && message.source) {
                    try {
                        // Parse the raw source to get clean text/html
                        const parsed = await simpleParser(message.source);
                        msgData.bodyText = parsed.text || '';
                        msgData.bodyHtml = parsed.html || parsed.textAsHtml || '';
                    } catch (parseErr) {
                        console.error(`[Proxy] Parsing error for UID ${message.uid}:`, parseErr.message);
                        msgData.bodyText = '[Error parsing email body]';
                    }
                }

                messages.push(msgData);
            }

            // IMAP returns 1..N, so the array is Oldest -> Newest.
            // We want Newest -> Oldest for the UI.
            messages.reverse();

            console.log(`[Proxy] Successfully processed ${messages.length} messages.`);

            res.json({
                success: true,
                messages: messages,
                count: messages.length
            });

        } finally {
            // Always release the lock
            lock.release();
        }

        await client.logout();

    } catch (err) {
        console.error('[Proxy] Critical Error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
});

app.listen(PORT, () => {
    console.log(`IMAP Proxy Server (ImapFlow) running on port ${PORT}`);
});
