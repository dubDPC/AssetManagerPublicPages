const { connectToDatabase } = require('../shared/db');
const UploadToken = require('../shared/uploadTokenModel');
const { getGraphClient } = require('../shared/graphClient');
const Busboy = require('busboy');

const ALLOWED_MIME_TYPES = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/tiff',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

function parseMultipart(req) {
    return new Promise((resolve, reject) => {
        const busboy = Busboy({
            headers: { 'content-type': req.headers['content-type'] },
            limits: { fileSize: MAX_FILE_SIZE, files: 10 }
        });

        const files = [];
        let token = null;

        busboy.on('field', (name, value) => {
            if (name === 'token') token = value;
        });

        busboy.on('file', (name, stream, info) => {
            const { filename, mimeType } = info;
            const chunks = [];

            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
                files.push({
                    filename,
                    mimeType,
                    buffer: Buffer.concat(chunks)
                });
            });
        });

        busboy.on('finish', () => resolve({ files, token }));
        busboy.on('error', reject);

        busboy.write(req.body);
        busboy.end();
    });
}

module.exports = async function (context, req) {
    try {
        const { files, token } = await parseMultipart(req);

        if (!token) {
            context.res = { status: 400, body: { error: 'Token is required' } };
            return;
        }

        if (!files.length) {
            context.res = { status: 400, body: { error: 'No files provided' } };
            return;
        }

        await connectToDatabase();

        const uploadToken = await UploadToken.findOne({ token });
        if (!uploadToken || !uploadToken.isValid()) {
            context.res = { status: 410, body: { error: 'Upload link is no longer valid' } };
            return;
        }

        const remaining = uploadToken.maxUploads - uploadToken.uploadsUsed;
        if (files.length > remaining) {
            context.res = { status: 400, body: { error: `Only ${remaining} upload(s) remaining` } };
            return;
        }

        // Validate file types
        for (const file of files) {
            if (!ALLOWED_MIME_TYPES.includes(file.mimeType)) {
                context.res = {
                    status: 400,
                    body: { error: `File type not allowed: ${file.filename}. Accepted: PDF, JPEG, PNG, TIFF, DOCX` }
                };
                return;
            }
        }

        const graphClient = getGraphClient();
        const oneDriveUser = process.env.ONEDRIVE_USER_EMAIL;
        const uploadResults = [];

        for (const file of files) {
            const folderPath = `AIFile-Uploads/${uploadToken.userId}`;
            const filePath = `${folderPath}/${Date.now()}-${file.filename}`;

            try {
                // Upload to OneDrive (small file API, up to 4MB)
                // For larger files, use upload session
                if (file.buffer.length <= 4 * 1024 * 1024) {
                    await graphClient
                        .api(`/users/${oneDriveUser}/drive/root:/${filePath}:/content`)
                        .put(file.buffer);
                } else {
                    // Create upload session for large files
                    const session = await graphClient
                        .api(`/users/${oneDriveUser}/drive/root:/${filePath}:/createUploadSession`)
                        .post({ item: { name: file.filename } });

                    // Upload in 4MB chunks
                    const chunkSize = 4 * 1024 * 1024;
                    for (let i = 0; i < file.buffer.length; i += chunkSize) {
                        const chunk = file.buffer.slice(i, Math.min(i + chunkSize, file.buffer.length));
                        const rangeEnd = Math.min(i + chunkSize - 1, file.buffer.length - 1);
                        await fetch(session.uploadUrl, {
                            method: 'PUT',
                            headers: {
                                'Content-Length': chunk.length,
                                'Content-Range': `bytes ${i}-${rangeEnd}/${file.buffer.length}`
                            },
                            body: chunk
                        });
                    }
                }

                uploadToken.uploads.push({
                    fileName: file.filename,
                    oneDrivePath: filePath
                });
                uploadToken.uploadsUsed += 1;
                uploadResults.push({ filename: file.filename, success: true });
            } catch (uploadErr) {
                context.log.error(`Failed to upload ${file.filename}:`, uploadErr);
                uploadResults.push({ filename: file.filename, success: false, error: 'Upload failed' });
            }
        }

        await uploadToken.save();

        context.res = {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: {
                results: uploadResults,
                remainingUploads: uploadToken.maxUploads - uploadToken.uploadsUsed
            }
        };
    } catch (error) {
        context.log.error('upload error:', error);
        context.res = { status: 500, body: { error: 'Internal server error' } };
    }
};
