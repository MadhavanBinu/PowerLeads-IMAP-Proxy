
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const Imap = require('imap-simple');
const { simpleParser } = require('mailparser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET; // REQUIRED: Set this in your deployment environment variables

app.use(cors());
// Increase limit for large email bodies
app.use(bodyParser.json({ limit: '50mb' }));

// Authentication Middleware
const authenticate = (req, res, next) => {
    const authHeader = req.headers['x-proxy-secret'];
    if (!PROXY_SECRET) {
        console.warn("WARNING: PROXY_SECRET is not set. The server is insecure.");
    } else if (authHeader !== PROXY_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized Proxy Access: Invalid Secret' });
    }
    next();
};

app.get('/', (req, res) => {
    res.send('PowerLeads.AI IMAP Proxy is running. POST to /fetch to retrieve emails.');
});

app.post('/fetch', authenticate, async (req, res) => {
    const { config, searchCriteria, fetchOptions, limit } = req.body;
    let connection = null;

    if (!config || !config.imap) {
        return res.status(400).json({ success: false, error: 'Missing IMAP configuration object' });
    }

    try {
        console.log(`Connecting to ${config.imap.host}:${config.imap.port} for user ${config.imap.user}`);
        
        // 1. Connect to IMAP Server
        connection = await Imap.connect(config);
        await connection.openBox('INBOX');

        // 2. Search for emails
        const criteria = searchCriteria || [['ALL']];
        const options = fetchOptions || { bodies: ['HEADER'], markSeen: false };
        
        const results = await connection.search(criteria, options);
        let finalResults = results;

        // 3. Apply Limit (if requested) to reduce bandwidth
        // Usually we want the most recent, so we slice from the end if sorting isn't specified
        if (limit && results.length > limit) {
            finalResults = results.slice(-limit);
        }
        
        console.log(`Found ${results.length} messages, returning ${finalResults.length}`);

        // 4. Process and Parse Results
        const messages = [];
        
        for (const item of finalResults) {
            try {
                const uid = item.attributes.uid;
                const headerPart = item.parts.find((p) => p.which === 'HEADER');
                
                let subject = '(No Subject)';
                let from = '(Unknown)';
                let date = new Date().toISOString();
                let messageId = null;

                if (headerPart && headerPart.body) {
                    subject = headerPart.body.subject ? headerPart.body.subject[0] : subject;
                    from = headerPart.body.from ? headerPart.body.from[0] : from;
                    date = headerPart.body.date ? headerPart.body.date[0] : date;
                    messageId = headerPart.body['message-id'] ? headerPart.body['message-id'][0] : null;
                }

                // If full body was requested (indicated by empty string or 'TEXT' in 'bodies')
                // We parse it using mailparser to give clean text/html to the client
                let bodyText = undefined;
                let bodyHtml = undefined;

                // FIX: Accept both '' (Full) and 'TEXT' (Body only) to support strict servers like Hostinger
                const fullBodyPart = item.parts.find((p) => p.which === '' || p.which === 'TEXT');
                
                if (fullBodyPart) {
                     const fullBodyData = await connection.getPartData(item, fullBodyPart);
                     try {
                        // simpleParser handles raw strings/buffers well. 
                        // If 'TEXT' is used, it parses the body content.
                        const parsed = await simpleParser(fullBodyData);
                        bodyText = parsed.text;
                        bodyHtml = parsed.html || parsed.textAsHtml; // Fallback if HTML missing
                        
                        // If parsing 'TEXT' part only, we might miss header metadata in 'parsed',
                        // so we preserve the values extracted from 'headerPart' above unless 'parsed' has better ones.
                        if (parsed.subject) subject = parsed.subject;
                        if (parsed.from?.text) from = parsed.from.text;
                        if (parsed.date) date = parsed.date.toISOString();
                        if (parsed.messageId) messageId = parsed.messageId;

                     } catch (parseErr) {
                         console.error(`Error parsing email UID ${uid}:`, parseErr);
                         bodyText = typeof fullBodyData === 'string' ? fullBodyData : "[Error parsing email content]";
                     }
                }

                messages.push({
                    uid,
                    messageId,
                    subject,
                    from,
                    date,
                    bodyText,
                    bodyHtml
                });
            } catch (itemErr) {
                console.error(`Error processing item UID ${item?.attributes?.uid}:`, itemErr);
                // Continue to next item instead of failing the whole batch
            }
        }

        res.json({
            success: true,
            messages: messages,
            totalFound: results.length
        });

    } catch (error) {
        console.error('IMAP Connection Error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'IMAP Connection Failed',
            code: error.code 
        });
    } finally {
        if (connection) {
            try { 
                connection.end(); 
            } catch(e) {
                console.error("Error closing connection:", e);
            }
        }
    }
});

app.listen(PORT, () => {
    console.log(`IMAP Proxy Server listening on port ${PORT}`);
});
