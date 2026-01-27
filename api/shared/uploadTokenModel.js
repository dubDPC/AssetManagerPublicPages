const mongoose = require('mongoose');

// Mirror of the UploadToken model from the main app
const uploadTokenSchema = new mongoose.Schema({
    token: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    bookId: { type: mongoose.Schema.Types.ObjectId, ref: 'Book' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    maxUploads: { type: Number, default: 10 },
    uploadsUsed: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active' },
    uploads: [{
        fileName: String,
        uploadedAt: { type: Date, default: Date.now },
        oneDrivePath: String
    }]
}, { timestamps: true });

uploadTokenSchema.methods.isValid = function() {
    if (this.status === 'revoked') return false;
    if (this.expiresAt < new Date()) return false;
    if (this.uploadsUsed >= this.maxUploads) return false;
    return true;
};

module.exports = mongoose.models.UploadToken || mongoose.model('UploadToken', uploadTokenSchema);
