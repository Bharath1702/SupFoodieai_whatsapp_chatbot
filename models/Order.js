const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    sender: String,
    items: [{
        id: String,
        title: String,
        price: Number,
        quantity: Number
    }],
    orderId: String,
    totalAmount: Number,
    status: { type: String, default: "Pending" },
    date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Order', orderSchema);
