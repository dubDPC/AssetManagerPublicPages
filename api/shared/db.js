const mongoose = require('mongoose');

let isConnected = false;

async function connectToDatabase() {
    if (isConnected) return;

    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI not configured');

    await mongoose.connect(uri);
    isConnected = true;
}

module.exports = { connectToDatabase };
