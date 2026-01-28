const { MongoClient, ObjectId } = require('mongodb');

let client = null;
let db = null;

async function getDb() {
    if (db) return db;
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db(process.env.MONGODB_DATABASE || 'aifile');
    return db;
}

module.exports = async function (context, req) {
    const token = req.query.token || (req.body && req.body.token);

    if (!token) {
        context.res = { status: 400, body: { error: 'Token is required' } };
        return;
    }

    try {
        const database = await getDb();
        const uploadToken = await database.collection('uploadtokens').findOne({ token });

        if (!uploadToken) {
            context.res = { status: 404, body: { error: 'Invalid upload link' } };
            return;
        }

        const now = new Date();
        const expiresAt = new Date(uploadToken.expiresAt);
        const isRevoked = uploadToken.status === 'revoked';
        const isExpired = expiresAt < now;
        const limitReached = uploadToken.uploadsUsed >= uploadToken.maxUploads;

        if (isRevoked || isExpired || limitReached) {
            const reason = isRevoked ? 'revoked' : isExpired ? 'expired' : 'limit_reached';
            context.res = { status: 410, body: { error: 'Upload link is no longer valid', reason } };
            return;
        }

        const user = await database.collection('users').findOne({ _id: new ObjectId(uploadToken.userId) });
        const clientName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : 'Customer';

        context.res = {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: {
                valid: true,
                clientName,
                remainingUploads: uploadToken.maxUploads - uploadToken.uploadsUsed,
                expiresAt: uploadToken.expiresAt
            }
        };
    } catch (error) {
        context.log.error('validate-token error:', error);
        context.res = { status: 500, body: { error: 'Internal server error' } };
    }
};
