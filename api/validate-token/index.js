const { connectToDatabase } = require('../shared/db');
const UploadToken = require('../shared/uploadTokenModel');
const mongoose = require('mongoose');

// User schema (minimal, just for name lookup)
const userSchema = new mongoose.Schema({
    firstName: String,
    lastName: String,
    email: String
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

module.exports = async function (context, req) {
    const token = req.query.token || (req.body && req.body.token);

    if (!token) {
        context.res = { status: 400, body: { error: 'Token is required' } };
        return;
    }

    try {
        await connectToDatabase();

        const uploadToken = await UploadToken.findOne({ token });

        if (!uploadToken) {
            context.res = { status: 404, body: { error: 'Invalid upload link' } };
            return;
        }

        if (!uploadToken.isValid()) {
            const reason = uploadToken.status === 'revoked' ? 'revoked'
                : uploadToken.expiresAt < new Date() ? 'expired'
                : 'limit_reached';
            context.res = { status: 410, body: { error: 'Upload link is no longer valid', reason } };
            return;
        }

        const user = await User.findById(uploadToken.userId).select('firstName lastName');
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
