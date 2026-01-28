const https = require('https');
const { MongoClient } = require('mongodb');

let client = null;
let db = null;

async function getDb() {
    if (db) return db;
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db(process.env.MONGODB_DATABASE || 'aifile');
    return db;
}

// --- Graph API helpers ---

let cachedToken = null;
let tokenExpiry = 0;

function httpsRequest(options, postData) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                let parsed;
                try { parsed = JSON.parse(body); } catch (e) { parsed = body; }
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ statusCode: res.statusCode, body: parsed });
                } else {
                    const err = new Error(`HTTP ${res.statusCode}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
                    err.statusCode = res.statusCode;
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
    const postData = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default'
    }).toString();
    const result = await httpsRequest({
        hostname: 'login.microsoftonline.com',
        path: `/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    }, postData);
    cachedToken = result.body.access_token;
    tokenExpiry = Date.now() + (result.body.expires_in * 1000);
    return cachedToken;
}

async function graphPut(path, buffer) {
    const token = await getAccessToken();
    return httpsRequest({
        hostname: 'graph.microsoft.com',
        path: `/v1.0${path}`,
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length }
    }, buffer);
}

async function graphPost(path, body) {
    const token = await getAccessToken();
    const postData = JSON.stringify(body);
    return httpsRequest({
        hostname: 'graph.microsoft.com',
        path: `/v1.0${path}`,
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, postData);
}

function rawPut(url, buffer, headers) {
    const parsed = new URL(url);
    return httpsRequest({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'PUT',
        headers: { ...headers, 'Content-Length': buffer.length }
    }, buffer);
}

// --- Multipart parser ---

const ALLOWED_MIME_TYPES = [
    'application/pdf', 'image/jpeg', 'image/png', 'image/tiff',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];
const MAX_FILE_SIZE = 50 * 1024 * 1024;

function parseMultipart(req) {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
    if (!boundaryMatch) throw new Error('No boundary found');

    const boundary = boundaryMatch[1];
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    const boundaryBuf = Buffer.from(`--${boundary}`);

    const parts = [];
    let token = null;
    let start = body.indexOf(boundaryBuf) + boundaryBuf.length;

    while (start < body.length) {
        const nextBoundary = body.indexOf(boundaryBuf, start);
        if (nextBoundary === -1) break;
        const part = body.slice(start, nextBoundary);
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) { start = nextBoundary + boundaryBuf.length; continue; }
        const headerStr = part.slice(0, headerEnd).toString();
        const content = part.slice(headerEnd + 4, part.length - 2);
        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const filenameMatch = headerStr.match(/filename="([^"]+)"/);
        const mimeMatch = headerStr.match(/Content-Type:\s*(.+)/i);
        if (nameMatch && nameMatch[1] === 'token' && !filenameMatch) {
            token = content.toString().trim();
        } else if (filenameMatch) {
            parts.push({ filename: filenameMatch[1], mimeType: mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream', buffer: content });
        }
        start = nextBoundary + boundaryBuf.length;
    }
    return { files: parts, token };
}

// --- Main function ---

module.exports = async function (context, req) {
    try {
        const { files, token } = parseMultipart(req);
        if (!token) { context.res = { status: 400, body: { error: 'Token is required' } }; return; }
        if (!files.length) { context.res = { status: 400, body: { error: 'No files provided' } }; return; }

        const database = await getDb();
        const uploadToken = await database.collection('uploadtokens').findOne({ token });

        if (!uploadToken) { context.res = { status: 410, body: { error: 'Upload link is no longer valid' } }; return; }

        const now = new Date();
        if (uploadToken.status === 'revoked' || new Date(uploadToken.expiresAt) < now || uploadToken.uploadsUsed >= uploadToken.maxUploads) {
            context.res = { status: 410, body: { error: 'Upload link is no longer valid' } }; return;
        }

        const remaining = uploadToken.maxUploads - uploadToken.uploadsUsed;
        if (files.length > remaining) { context.res = { status: 400, body: { error: `Only ${remaining} upload(s) remaining` } }; return; }

        for (const file of files) {
            if (!ALLOWED_MIME_TYPES.includes(file.mimeType)) {
                context.res = { status: 400, body: { error: `File type not allowed: ${file.filename}` } }; return;
            }
            if (file.buffer.length > MAX_FILE_SIZE) {
                context.res = { status: 400, body: { error: `File too large: ${file.filename}. Max 50MB.` } }; return;
            }
        }

        const oneDriveUser = process.env.ONEDRIVE_USER_EMAIL;
        const userId = uploadToken.userId.toString();
        const uploadResults = [];
        const newUploads = [];

        for (const file of files) {
            const filePath = `AIFile-Uploads/${userId}/${Date.now()}-${file.filename}`;
            try {
                if (file.buffer.length <= 4 * 1024 * 1024) {
                    await graphPut(`/users/${oneDriveUser}/drive/root:/${filePath}:/content`, file.buffer);
                } else {
                    const session = await graphPost(
                        `/users/${oneDriveUser}/drive/root:/${filePath}:/createUploadSession`,
                        { item: { name: file.filename } }
                    );
                    const chunkSize = 4 * 1024 * 1024;
                    for (let i = 0; i < file.buffer.length; i += chunkSize) {
                        const chunk = file.buffer.slice(i, Math.min(i + chunkSize, file.buffer.length));
                        const rangeEnd = Math.min(i + chunkSize - 1, file.buffer.length - 1);
                        await rawPut(session.body.uploadUrl, chunk, {
                            'Content-Range': `bytes ${i}-${rangeEnd}/${file.buffer.length}`
                        });
                    }
                }
                newUploads.push({ fileName: file.filename, oneDrivePath: filePath, uploadedAt: new Date() });
                uploadResults.push({ filename: file.filename, success: true });
            } catch (uploadErr) {
                context.log.error(`Failed to upload ${file.filename}:`, uploadErr);
                uploadResults.push({ filename: file.filename, success: false, error: 'Upload failed' });
            }
        }

        const successCount = uploadResults.filter(r => r.success).length;
        if (successCount > 0) {
            await database.collection('uploadtokens').updateOne(
                { _id: uploadToken._id },
                { $inc: { uploadsUsed: successCount }, $push: { uploads: { $each: newUploads } } }
            );
        }

        context.res = {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: { results: uploadResults, remainingUploads: remaining - successCount }
        };
    } catch (error) {
        context.log.error('upload error:', error);
        context.res = { status: 500, body: { error: 'Internal server error' } };
    }
};
