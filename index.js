// File: app.js

require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const mongoose = require("mongoose");
const Razorpay = require('razorpay');

const app = express();
app.use(bodyParser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;
const mongodbUri = process.env.MONGODB_URI;
const phone_number_id = process.env.PHONE_NUMBER_ID;
const port = process.env.PORT || 80;

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

if (!mongodbUri) {
    console.error("MongoDB URI is not defined. Please check your .env file.");
    process.exit(1);
}

// Connect to MongoDB
mongoose.connect(mongodbUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
});

// Global Variables
let awaitingHotelId = {};
let menuItems = {};  // Store menu items per sender
let awaitingQuantity = {};
let awaitingOrderId = {};
let orders = {};
let hotelIds = {};   // Store hotel IDs and timestamps per sender
let userInteractionTimestamps = {};  // Track last interaction time per sender

// Start server
app.listen(port, () => {
    console.log(`Webhook is listening on port ${port}`);
});

// Helper functions for hotel connection
function isHotelConnectionActive(sender) {
    const hotelConnection = hotelIds[sender];
    if (hotelConnection) {
        const elapsedTime = Date.now() - hotelConnection.timestamp;
        return elapsedTime < 3600000; // 1 hour in milliseconds
    }
    return false;
}

// Polling function to check for status changes
async function checkForOrderUpdates() {
    console.log("Polling for order updates...");

    try {
        // For each sender, check for order updates
        for (const sender in hotelIds) {
            const hotelId = hotelIds[sender].hotelId;
            const Order = getOrderModel(hotelId);

            // Find all orders where the current status is different from the last notified status
            const ordersToUpdate = await Order.find({
                sender,
                $expr: { $ne: ["$status", "$lastNotifiedStatus"] }
            });

            console.log(`Found ${ordersToUpdate.length} orders with updated statuses for sender ${sender}.`);

            for (const order of ordersToUpdate) {
                const currentStatus = order.status;
                const lastNotifiedStatus = order.lastNotifiedStatus;

                console.log(`Order ${order.orderId}: status=${currentStatus}, lastNotifiedStatus=${lastNotifiedStatus}`);

                if (currentStatus !== lastNotifiedStatus) {
                    console.log(`Sending update for order ${order.orderId} with status: ${currentStatus}`);
                    await sendStatusUpdate(sender, order, currentStatus);

                    // Update the lastNotifiedStatus after sending the message
                    order.lastNotifiedStatus = currentStatus;
                    await order.save().catch(err => {
                        console.error(`Error saving order ${order.orderId}:`, err);
                    });
                }
            }
        }
    } catch (error) {
        console.error('Error checking for order updates:', error.stack);
    }
}

// Run the polling function every minute (60000 milliseconds)
setInterval(checkForOrderUpdates, 60000);  // 60000 milliseconds = 1 minute

// Function to send order status update to the user
async function sendStatusUpdate(sender, order, status) {
    let message = '';

    switch (status) {
        case 'Accepted':
            message = 'Your order has been accepted!';
            break;
        case 'Cooking':
            message = 'Your food is being cooked!';
            break;
        case 'Ready':
            message = 'Your order is ready for pickup!';
            break;
        case 'Rejected':
            message = 'Unfortunately, your order was rejected.';
            break;
        case 'Cancelled':
            message = 'Your order has been cancelled.';
            break;
        case 'Completed':
            message = 'Your order has been completed. Thank you!';
            break;
        default:
            message = `There has been an update to your order status: ${status}`;
    }

    await sendReply(sender, message);  // Send the message using WhatsApp API
}

// WhatsApp webhook setup
app.get("/webhook", (req, res) => {
    let mode = req.query["hub.mode"];
    let challenge = req.query["hub.challenge"];
    let verify_token = req.query["hub.verify_token"];

    if (mode && verify_token) {
        if (mode === "subscribe" && verify_token === mytoken) {
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

app.post("/webhook", async (req, res) => {
    try {
        let body_param = req.body;
        console.log(JSON.stringify(body_param, null, 2));

        if (body_param.object) {
            const entry = body_param.entry && body_param.entry[0];
            const change = entry && entry.changes && entry.changes[0];
            const value = change && change.value;

            if (value.messages && value.messages[0]) {
                let from = value.messages[0].from;
                // Extract the message body as you currently do.
                let msg_body =
                    (value.messages[0].interactive && value.messages[0].interactive.button_reply && value.messages[0].interactive.button_reply.id) ||
                    (value.messages[0].interactive && value.messages[0].interactive.list_reply && value.messages[0].interactive.list_reply.id) ||
                    value.messages[0].text.body;
                
                updateLastInteraction(from);
                await handleIncomingMessage(from, msg_body);
                res.sendStatus(200);
            } else if (value.statuses && value.statuses[0]) {
                // Handle status updates (like message sent, delivered, etc.)
                console.log("Received status update:", value.statuses[0]);
                // Process status update if needed.
                res.sendStatus(200);
            } else {
                res.sendStatus(404);
            }
        } else {
            res.sendStatus(404);
        }
    } catch (error) {
        console.error("Error handling webhook event:", error.stack);
        res.sendStatus(500);
    }
});

// Update Menu Item Schema to include availability and estimatedTime
const menuItemSchema = new mongoose.Schema({
    id: String,
    title: String,
    price: Number,
    category: String,
    availability: {
        type: Boolean,
        default: true
    },
    estimatedTime: {
        type: Number,
        default: 15  // Default estimated time in minutes
    }
});

// Define Order Schema
const orderSchema = new mongoose.Schema({
    sender: String,
    items: [{
        id: String,
        title: String,
        price: Number,
        quantity: Number,
        estimatedTime: Number  // Include estimatedTime in ordered items
    }],
    orderId: String,
    totalAmount: Number,
    paymentMethod: {
        type: String,
        enum: ['Cash', 'Online'],
        default: 'Cash'
    },
    paymentStatus: {
        type: String,
        enum: ['Pending', 'Paid', 'Failed'],
        default: 'Pending'
    },
    date: { type: Date, default: Date.now },
    status: {
        type: String,
        enum: ['Pending', 'Accepted', 'Rejected', 'Cooking', 'Ready', 'Cancelled', 'Completed'],
        default: 'Pending'
    },
    lastNotifiedStatus: {  // Field to track last notified status
        type: String,
        default: 'Pending'
    }
});

// Function to get Menu Model for a Hotel ID
function getMenuModel(hotelId) {
    return mongoose.model(`menu_${hotelId}`, menuItemSchema, `menu_${hotelId}`);
}

// Function to get Order Model for a Hotel ID
function getOrderModel(hotelId) {
    return mongoose.model(`orders_${hotelId}`, orderSchema, `orders_${hotelId}`);
}

async function saveOrderToDatabase(sender, orderId, paymentMethod = 'Cash', paymentStatus = 'Pending') {
    try {
        let totalAmount = 0;
        const hotelId = hotelIds[sender].hotelId;
        const Order = getOrderModel(hotelId);

        if (orders[sender] && orders[sender].items && orders[sender].items.length > 0) {
            orders[sender].items.forEach(item => {
                const itemTotal = item.price * item.quantity;
                totalAmount += itemTotal;
            });

            // Save order to database
            const newOrder = new Order({
                sender,
                items: orders[sender].items,
                orderId,
                totalAmount,
                paymentMethod,
                paymentStatus,
                status: 'Pending'  // Default order status
            });
            await newOrder.save();
            console.log("Order saved successfully:", newOrder);  // Log saved order

            // Clear the order
            resetOrder(sender);
        } else {
            console.log("No items found in the order for sender:", sender);
        }
    } catch (error) {
        console.error("Error saving order to database:", error.stack);
        throw error;  // Rethrow to handle in higher-level logic
    }
}

async function sendReceipt(sender, orderId) {
    try {
        const hotelId = hotelIds[sender].hotelId;
        const Order = getOrderModel(hotelId);

        // Retrieve the order from the database using the orderId
        const order = await Order.findOne({ orderId, sender });
        if (!order) {
            await sendReply(sender, "Sorry, we couldn't find your order. Please try again.");
            return;
        }

        // Build the receipt message
        let receiptMessage = `Order Receipt:\nOrder ID: ${order.orderId}\n\n`;
        order.items.forEach(item => {
            receiptMessage += `${item.title} x ${item.quantity} = ₹${item.price * item.quantity}\n`;
        });
        receiptMessage += `\nTotal Amount: ₹${order.totalAmount}\n`;
        receiptMessage += `Payment Method: ${order.paymentMethod}\n`;
        receiptMessage += `Order Status: ${order.status}\n`;

        // Calculate average estimated time
        let totalEstimatedTime = 0;
        let totalQuantity = 0;
        order.items.forEach(item => {
            totalEstimatedTime += item.estimatedTime * item.quantity;
            totalQuantity += item.quantity;
        });
        const averageEstimatedTime = Math.ceil(totalEstimatedTime / totalQuantity);
        receiptMessage += `*Your Order Will Be Ready in* : ${averageEstimatedTime} minutes\n`;

        receiptMessage += `\nThank you for your order!`;

        // Send the receipt as a reply
        await sendReply(sender, receiptMessage, false);
    } catch (error) {
        console.error('Error sending receipt:', error.stack);
        await sendReply(sender, "Something went wrong while generating your receipt. Please try again.");
    }
}

async function handleIncomingMessage(sender, message) {
    try {
        // Check if hotel connection is active
        if (!hotelIds[sender] || !isHotelConnectionActive(sender)) {
            delete hotelIds[sender]; // Clear expired hotel connection

            if (message.toLowerCase() === 'hi' || message.toLowerCase() === 'hii' || message.toLowerCase() === 'start') {
                awaitingHotelId[sender] = true;
                // Set timeout to clear awaitingHotelId after 5 minutes
                setTimeout(() => {
                    if (awaitingHotelId[sender]) {
                        delete awaitingHotelId[sender];
                        sendReply(sender, "Hotel ID input timed out. Please send 'hi' to start again.", false);
                    }
                }, 300000); // 5 minutes
                await sendReply(sender, 'Welcome! Please scan the QR code on the table or enter the Hotel ID to proceed:', false);
            } else {
                // Assume message is a hotel ID
                const hotelId = message.trim();
                try {
                    const menuCollectionExists = await mongoose.connection.db.listCollections({ name: `menu_${hotelId}` }).hasNext();
                    if (menuCollectionExists) {
                        hotelIds[sender] = {
                            hotelId: hotelId,
                            timestamp: Date.now()
                        };
                        delete awaitingHotelId[sender];
                        await loadMenuItems(sender);
                        await sendCatalog(sender, 'Hotel ID verified. How can we assist you today?');
                    } else {
                        awaitingHotelId[sender] = true;
                        await sendReply(sender, 'Invalid Hotel ID. Please check the Hotel ID and try again:', false);
                    }
                } catch (error) {
                    console.error("Error validating hotel ID:", hotelId, "Error:", error.stack);
                    awaitingHotelId[sender] = true;
                    await sendReply(sender, 'Error validating Hotel ID. Please try again:', false);
                }
            }
            return; // Exit since hotel ID is now set or we're waiting for a valid hotel ID
        }

        // Hotel ID is set; proceed with existing logic
        // Check if we are awaiting quantity input for an item
        if (awaitingQuantity[sender]) {
            const item = awaitingQuantity[sender];
            delete awaitingQuantity[sender];
        
            // Handle quantity selection
            if (message.startsWith('Qty_')) {
                const quantity = parseInt(message.split('_')[1]);
                if (!isNaN(quantity) && quantity > 0) {
                    if (!orders[sender]) {
                        orders[sender] = { items: [] };
                    }
                    // Add or update the item in the order
                    const existingItem = orders[sender].items.find(i => i.id === item.id);
                    if (existingItem) {
                        existingItem.quantity += quantity;
                    } else {
                        orders[sender].items.push({ ...item, quantity });
                    }
                    // Build the cart summary
                    let cartSummary = "\nYour Current Order:\n";
                    orders[sender].items.forEach((cartItem, index) => {
                        cartSummary += `${index + 1}. ${cartItem.title} x ${cartItem.quantity} = ₹${cartItem.price * cartItem.quantity}\n`;
                    });
                    // Send 'Place Order' and 'Edit Order' buttons with cart summary
                    await sendOrderOptions(sender, `Added ${quantity} x ${item.title} to your order.${cartSummary}\nYou can select more items from the menu which was sent earlier, or choose an option.`);
                    // Do not send the menu again
                } else {
                    awaitingQuantity[sender] = item;  // Re-prompt for quantity
                    await sendQuantityOptions(sender, item);
                }
            } else {
                awaitingQuantity[sender] = item;  // Re-prompt for quantity
                await sendQuantityOptions(sender, item);
            }
        }
        
        // Handle order tracking by order ID
        else if (awaitingOrderId[sender]) {
            const orderId = message;
            delete awaitingOrderId[sender];
            await trackOrderByID(sender, orderId);
        }
        // General commands for starting or continuing interaction
        else if (message === 'ViewMenu') {
            await sendMenu(sender);
        }
        // Place the order and review the summary
        else if (message === 'PlaceOrder') {
            await sendOrderSummary(sender);
        }
        // Edit the current order
        else if (message === 'EditOrder') {
            await sendEditOrderOptions(sender);
        }
        // Main Menu option
        else if (message === 'MainMenu') {
            await sendCatalog(sender);
        }
        // Track Order Status
        else if (message === 'TrackOrderStatus') {
            await sendTrackOrderOptions(sender);
        }
        // Track the current order status
        else if (message === 'TrackCurrentOrder') {
            await trackOrderStatus(sender);
        }
        // Track an order by ID
        else if (message === 'TrackOrderByID') {
            awaitingOrderId[sender] = true;
            await sendReply(sender, 'Please enter your Order ID:', false);
        }
        // Handle item selection from menu
        else if (message.startsWith('Item_')) {
            const itemId = message.split('_')[1];
            const item = menuItems[sender].find(i => i.id === itemId);
            if (item) {
                awaitingQuantity[sender] = item;
                await sendQuantityOptions(sender, item);
            }
        }
        // Remove an item from the order
        else if (message.startsWith('Remove_')) {
            const itemId = message.split('_')[1];
            if (orders[sender] && orders[sender].items) {
                orders[sender].items = orders[sender].items.filter(item => item.id !== itemId);
                await sendOrderOptions(sender, `Removed item from your order. You can select more items from the menu which was sent earlier, or choose an option.`);
                // Do not send the menu again
            }
        }
        // Place another order
        else if (message === 'OrderAgain') {
            await sendCatalog(sender, 'Would you like to place another order? Here is the menu:');
        }
        // Cancel an order by ID
        else if (message.startsWith('CancelOrder_')) {
            const orderId = message.split('_')[1];
            await cancelOrder(sender, orderId);
        }
        // Handle Pay Cash option
        else if (message === 'PayCash') {
            const orderId = generateOrderId();  // Generate Order ID for cash payment
            await saveOrderToDatabase(sender, orderId, 'Cash', 'Pending');  // Save the order to the database
            await sendReceipt(sender, orderId);  // Send the receipt to the user
            await sendReply(sender, 'Your order has been placed and will be processed shortly.', false);
        }
        // Handle Pay Online option with Razorpay payment link
        else if (message === 'PayOnline') {
            // Calculate the total amount and create Razorpay payment link
            let totalAmount = 0;
            if (orders[sender] && orders[sender].items && orders[sender].items.length > 0) {
                orders[sender].items.forEach(item => {
                    totalAmount += item.price * item.quantity;
                });

                // Create a Razorpay payment link
                const paymentLinkData = {
                    amount: totalAmount * 100, // amount in paise
                    currency: 'INR',
                    accept_partial: false,
                    description: 'Payment for your order',
                    customer: {
                        contact: sender.replace(/\D/g, ''), // Remove non-digit characters from the phone number
                    },
                    notify: {
                        sms: false,
                        email: false,
                        whatsapp: false,
                    },
                    reminder_enable: true,
                    notes: {
                        order_id: generateOrderId(), // You can generate an order ID here if needed
                    }
                };

                try {
                    const paymentLink = await razorpay.paymentLink.create(paymentLinkData);
                    // Store the payment link ID and order details
                    if (!orders[sender]) {
                        orders[sender] = { items: [] };
                    }
                    orders[sender].paymentLinkId = paymentLink.id;
                    orders[sender].paymentLink = paymentLink.short_url;
                    orders[sender].totalAmount = totalAmount;
                    await sendPaymentLinkWithButtons(sender, paymentLink.short_url, totalAmount);
                } catch (error) {
                    console.error('Error creating Razorpay payment link:', error.stack);
                    await sendReply(sender, 'Failed to create payment link. Please try again later.');
                }
            } else {
                await sendReply(sender, "Your order is empty. Please add items to your order.");
            }
        }
        // Handle Payment Completed action
        else if (message === 'PaymentCompleted') {
            // Check payment status with Razorpay
            if (orders[sender] && orders[sender].paymentLinkId) {
                const paymentLinkId = orders[sender].paymentLinkId;

                try {
                    // Fetch payment link details from Razorpay
                    const paymentLinkDetails = await razorpay.paymentLink.fetch(paymentLinkId);

                    if (paymentLinkDetails.status === 'paid') {
                        // Payment was successful
                        const orderId = generateOrderId();  // Generate Order ID
                        await saveOrderToDatabase(sender, orderId, 'Online', 'Paid');  // Save the order to the database
                        await sendReceipt(sender, orderId);  // Send the receipt to the user

                        // Clear the paymentLinkId and paymentLink
                        delete orders[sender].paymentLinkId;
                        delete orders[sender].paymentLink;

                        await sendReply(sender, 'Payment received successfully! Your order has been placed.', false);
                    } else {
                        // Payment not completed
                        await sendReply(sender, 'Payment not completed yet. Please complete the payment using the link below.');
                        // Resend the payment link with buttons
                        await sendPaymentLinkWithButtons(sender, orders[sender].paymentLink, orders[sender].totalAmount);
                    }
                } catch (error) {
                    console.error('Error fetching payment link details:', error.stack);
                    await sendReply(sender, 'Failed to verify payment. Please try again later.');
                }
            } else {
                await sendReply(sender, 'No payment link found. Please try placing the order again.');
            }
        }
        // Handle Cancel Order action after payment link is sent
        else if (message === 'CancelOrder') {
            // Reset the order
            resetOrder(sender);
            await sendReply(sender, 'Your order has been cancelled.');
            // Also, if there's a paymentLinkId, cancel the payment link via Razorpay API
            if (orders[sender] && orders[sender].paymentLinkId) {
                const paymentLinkId = orders[sender].paymentLinkId;
                try {
                    await razorpay.paymentLink.cancel(paymentLinkId);
                    delete orders[sender].paymentLinkId;
                    delete orders[sender].paymentLink;
                    console.log('Payment link cancelled successfully');
                } catch (error) {
                    console.error('Error cancelling payment link:', error.stack);
                }
            }
        }
        // Handle Disconnect Hotel action
        else if (message === 'DisconnectHotel') {
            delete hotelIds[sender];
            await sendReply(sender, 'You have been disconnected from the hotel. Please enter a new Hotel ID to proceed:', false);
            awaitingHotelId[sender] = true;
            // Set timeout to clear awaitingHotelId after 5 minutes
            setTimeout(() => {
                if (awaitingHotelId[sender]) {
                    delete awaitingHotelId[sender];
                    sendReply(sender, "Hotel ID input timed out. Please send 'hi' to start again.", false);
                }
            }, 300000); // 5 minutes
        }
        // Fallback for unrecognized messages
        else {
            await sendReply(sender, "Sorry, I didn't understand that.\nPlease type 'Hi' to begin.");
        }
    } catch (error) {
        console.error("Error handling incoming message for sender:", sender, "Message:", message, "Error:", error.stack);
        await sendReply(sender, `An error occurred: ${error.message}. Please try again.`);
    }
}

async function loadMenuItems(sender) {
    const hotelId = hotelIds[sender].hotelId;
    const MenuItem = getMenuModel(hotelId);
    try {
        // Fetch only items where availability is true
        const items = await MenuItem.find({ availability: true });
        menuItems[sender] = items.map(item => ({
            id: item.id,
            title: item.title,
            price: item.price,
            category: item.category,
            estimatedTime: item.estimatedTime
        }));
        console.log(`Menu items loaded for sender ${sender} and hotel ID ${hotelId}`);
    } catch (error) {
        console.error('Error loading menu items:', error.stack);
        menuItems[sender] = [];
    }
}

async function sendQuantityOptions(sender, item) {
    const quantityOptions = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: sender,
        type: "interactive",
        interactive: {
            type: "list",
            header: {
                type: "text",
                text: `Select quantity for ${item.title}`
            },
            body: {
                text: `Choose a quantity for ${item.title}:`
            },
            action: {
                button: "Select Quantity",
                sections: [
                    {
                        title: "Quantities",
                        rows: Array.from({ length: 10 }, (_, i) => ({
                            id: `Qty_${i + 1}`,
                            title: `${i + 1}`
                        }))
                    }
                ]
            }
        }
    };

    await sendReplyInteractive(sender, quantityOptions);
}

async function sendCatalog(sender, extraMessage = 'How can we assist you today?') {
    const catalogMessage = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: sender,
        type: "interactive",
        interactive: {
            type: "list",
            header: {
                type: "text",
                text: "Welcome to Our Food Service"
            },
            body: {
                text: extraMessage
            },
            action: {
                button: "Choose an option",
                sections: [
                    {
                        title: "Main Menu",
                        rows: [
                            {
                                id: "ViewMenu",
                                title: "View Menu",
                                description: "Browse our delicious menu items"
                            },
                            {
                                id: "PlaceOrder",
                                title: "Place Order",
                                description: "Complete your current order"
                            },
                            {
                                id: "EditOrder",
                                title: "Edit Order",
                                description: "Modify or remove items from your order"
                            },
                            {
                                id: "TrackOrderStatus",
                                title: "Track Order",
                                description: "Track the status of your current order"
                            },
                            {
                                id: "DisconnectHotel",
                                title: "Disconnect Hotel",
                                description: "Connect to a different hotel"
                            }
                        ]
                    }
                ]
            }
        }
    };

    await sendReplyInteractive(sender, catalogMessage);
}

// Modified sendMenu function to display menu category-wise and handle more than 10 items
async function sendMenu(sender, extraMessage = '') {
    const items = menuItems[sender];
    if (!items || items.length === 0) {
        await sendReply(sender, 'Menu is not available. Please try again later.');
        return;
    }

    // Group items by category
    const categories = {};
    items.forEach(item => {
        if (!categories[item.category]) {
            categories[item.category] = [];
        }
        categories[item.category].push(item);
    });

    // Note: We need to send only one message per category with up to 10 items per list
    for (const category in categories) {
        const categoryItems = categories[category];

        // Split category items into chunks of 10
        const itemChunks = [];
        for (let i = 0; i < categoryItems.length; i += 10) {
            itemChunks.push(categoryItems.slice(i, i + 10));
        }

        for (let chunkIndex = 0; chunkIndex < itemChunks.length; chunkIndex++) {
            const chunk = itemChunks[chunkIndex];
            const sectionTitle = chunk.length > 1 ? `Page ${chunkIndex + 1}` : '';

            const menuMessage = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: sender,
                type: "interactive",
                interactive: {
                    type: "list",
                    header: {
                        type: "text",
                        text: category
                    },
                    body: {
                        text: `Please choose an item from ${category}:`
                    },
                    footer: {
                        text: "Select an item to add to your order"
                    },
urri: {
                        button: "Menu Items",
                        sections: [
                            {
                                title: sectionTitle,
                                rows: chunk.map(item => ({
                                    id: `Item_${item.id}`,
                                    title: item.title,
                                    description: `₹${item.price}`
                                }))
                            }
                        ]
                    }
                }
            };

            await sendReplyInteractive(sender, menuMessage);
        }
    }
}

// Function to send 'Place Order' and 'Edit Order' buttons
async function sendOrderOptions(sender, messageText) {
    const message = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: sender,
        type: "interactive",
        interactive: {
            type: "button",
            body: {
                text: messageText + "\n\n*You can select more items from the menu which was sent earlier, or choose an option.*"
            },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "PlaceOrder", title: "Place Order" } },
                    { type: "reply", reply: { id: "EditOrder", title: "Edit Order" } }
                ]
            }
        }
    };

    try {
        const lastInteraction = getLastInteractionTimestamp(sender);
        if (isWithin24Hours(lastInteraction)) {
            const response = await axios({
                method: "POST",
                url: `https://graph.facebook.com/v13.0/${phone_number_id}/messages?access_token=${token}`,
                data: message,
                headers: {
                    "Content-Type": "application/json"
                }
            });
            console.log('Order options sent:', response.data);
        } else {
            // Send a template message to re-engage the user
            await sendTemplateMessage(sender, 'your_template_name');  // Replace with your template name
        }
    } catch (error) {
        console.error('Error sending order options:', error.stack);
    }
}

async function sendEditOrderOptions(sender) {
    const order = (orders[sender] && orders[sender].items) || [];
    if (order.length === 0) {
        await sendReply(sender, "Your order is empty.");
        return;
    }
    const editOrderMessage = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: sender,
        type: "interactive",
        interactive: {
            type: "list",
            header: {
                type: "text",
                text: "Edit Order"
            },
            body: {
                text: "Select an item to remove from your order:"
            },
            footer: {
                text: "Choose an item to remove"
            },
            action: {
                button: "Order Items",
                sections: [
                    {
                        title: "Current Order",
                        rows: order.map(item => ({
                            id: `Remove_${item.id}`,
                            title: item.title,
                            description: `Quantity: ${item.quantity}`
                        }))
                    }
                ]
            }
        }
    };

    await sendReplyInteractive(sender, editOrderMessage);
}

function generateOrderId() {
    return Math.floor(10000000 + Math.random() * 90000000).toString();  // 8-digit order ID
}

async function sendReplyWithPaymentOptions(sender, orderSummary) {
    const paymentOptions = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: sender,
        type: "interactive",
        interactive: {
            type: "button",
            body: {
                text: `${orderSummary}\n\nPlease choose a payment method:`
            },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "PayOnline", title: "Pay Online" } },
                    { type: "reply", reply: { id: "PayCash", title: "Pay Cash" } },
                    { type: "reply", reply: { id: "DisconnectHotel", title: "Disconnect Hotel" } }
                ]
            }
        }
    };

    await sendReplyInteractive(sender, paymentOptions);
}

async function sendOrderSummary(sender) {
    let orderSummary = "Order Summary:\n";
    let totalAmount = 0;
    let totalEstimatedTime = 0;
    let totalQuantity = 0;

    if (orders[sender] && orders[sender].items && orders[sender].items.length > 0) {
        orders[sender].items.forEach(item => {
            const itemTotal = item.price * item.quantity;
            totalAmount += itemTotal;
            totalEstimatedTime += item.estimatedTime * item.quantity;
            totalQuantity += item.quantity;
            orderSummary += `${item.title} x ${item.quantity} = ₹${itemTotal}\n`;
        });

        orderSummary += `Total Amount: ₹${totalAmount}\n`;

        // Calculate average estimated time
        const averageEstimatedTime = Math.ceil(totalEstimatedTime / totalQuantity);
        orderSummary += `Estimated Waiting Time: ${averageEstimatedTime} minutes\n`;

        // Send order summary with payment buttons
        await sendReplyWithPaymentOptions(sender, orderSummary);
    } else {
        orderSummary = "You have no items in your order.\nSend 'hi' to order something.";
        await sendReply(sender, orderSummary);
    }
}

async function sendReplyWithButton(sender, reply, orderComplete = false) {
    const buttons = orderComplete ? [
        { type: "reply", reply: { id: "OrderAgain", title: "Order Again" } },
        { type: "reply", reply: { id: "MainMenu", title: "Main Menu" } },
        { type: "reply", reply: { id: "DisconnectHotel", title: "Disconnect Hotel" } }
    ] : [
        { type: "reply", reply: { id: "TrackOrderStatus", title: "Check Order Status" } },
        { type: "reply", reply: { id: "MainMenu", title: "Main Menu" } },
        { type: "reply", reply: { id: "DisconnectHotel", title: "Disconnect Hotel" } }
    ];

    const message = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: sender,
        type: "interactive",
        interactive: {
            type: "button",
            body: {
                text: reply
            },
            action: {
                buttons: buttons
            }
        }
    };

    try {
        const lastInteraction = getLastInteractionTimestamp(sender);
        if (isWithin24Hours(lastInteraction)) {
            const response = await axios({
                method: "POST",
                url: `https://graph.facebook.com/v13.0/${phone_number_id}/messages?access_token=${token}`,
                data: message,
                headers: {
                    "Content-Type": "application/json"
                }
            });
            console.log('Message with button sent:', response.data);
        } else {
            // Send a template message to re-engage the user
            await sendTemplateMessage(sender, 'your_template_name');  // Replace with your template name
        }
    } catch (error) {
        console.error('Error sending message with button:', error.stack);
    }
}

async function sendReply(sender, reply, sendStatusButton = true) {
    try {
        const lastInteraction = getLastInteractionTimestamp(sender);
        if (isWithin24Hours(lastInteraction)) {
            // Send a regular text message
            await sendTextMessage(sender, reply);
        } else {
            // Send a template message
            await sendTemplateMessage(sender, 'your_template_name');  // Replace 'your_template_name' with your actual template name
        }

        if (sendStatusButton) {
            await sendReplyWithButton(sender, "Click the button below to check your order status or disconnect the hotel.\nSend 'hi' to place a new order");
        }
    } catch (error) {
        console.error('Error in sendReply for sender:', sender, 'Reply:', reply, 'Error:', error.stack);
        throw error; // Rethrow to let the caller handle it
    }
}

async function sendTextMessage(sender, text) {
    const message = {
        messaging_product: "whatsapp",
        to: sender,
        text: {
            body: text
        }
    };

    try {
        const response = await axios.post(
            `https://graph.facebook.com/v13.0/${phone_number_id}/messages?access_token=${token}`,
            message,
            { headers: { "Content-Type": "application/json" } }
        );
        console.log('Text message sent:', response.data);
    } catch (error) {
        console.error('Error sending text message:', error.stack);
    }
}

async function sendTemplateMessage(sender, templateName, templateVariables = []) {
    const message = {
        messaging_product: "whatsapp",
        to: sender,
        type: "template",
        template: {
            name: templateName,
            language: {
                code: "en_US"
            },
            components: [
                {
                    type: "body",
                    parameters: templateVariables.map(text => ({ type: "text", text }))
                }
            ]
        }
    };

    try {
        const response = await axios.post(
            `https://graph.facebook.com/v13.0/${phone_number_id}/messages?access_token=${token}`,
            message,
            { headers: { "Content-Type": "application/json" } }
        );
        console.log('Template message sent:', response.data);
    } catch (error) {
        console.error('Error sending template message:', error.stack);
    }
}

async function sendReplyInteractive(sender, interactiveMessage) {
    try {
        const lastInteraction = getLastInteractionTimestamp(sender);
        if (isWithin24Hours(lastInteraction)) {
            const response = await axios({
                method: "POST",
                url: `https://graph.facebook.com/v13.0/${phone_number_id}/messages?access_token=${token}`,
                data: interactiveMessage,
                headers: {
                    "Content-Type": "application/json"
                }
            });
            console.log('Interactive message sent:', response.data);
        } else {
            // Send a template message to re-engage the user
            await sendTemplateMessage(sender, 'your_template_name');  // Replace with your template name
        }
    } catch (error) {
        console.error('Error sending interactive message:', error.stack);
    }
}

function resetOrder(sender) {
    delete orders[sender];
}

async function trackOrderStatus(sender) {
    try {
        const hotelId = hotelIds[sender].hotelId;
        const Order = getOrderModel(hotelId);
        const latestOrder = await Order.findOne({ sender }).sort({ date: -1 });
        if (latestOrder) {
            let message;
            let orderComplete = false;
            switch (latestOrder.status) {
                case 'Accepted':
                    message = 'Your order is confirmed.';
                    break;
                case 'Rejected':
                    message = "Sorry to say this, \nWe couldn't complete your order.\nSEND 'hi' to order again.";
                    break;
                case 'Cooking':
                    message = 'Your food is being prepared.';
                    break;
                case 'Ready':
                    message = 'Your order is ready. Please collect your item.';
                    orderComplete = true;
                    break;
                case 'Cancelled':
                    message = 'Your order was cancelled.';
                    orderComplete = true;
                    break;
                case 'Completed':
                    message = 'Your order has been completed. Thank you!';
                    orderComplete = true;
                    break;
                default:
                    message = "Wait while your order is being confirmed.";
            }
            if (latestOrder.status === 'Pending') {
                message += "\nIf you wish to cancel your order, click the button below.";
                await sendReplyWithCancelOption(sender, message, latestOrder.orderId);
            } else {
                await sendReplyWithButton(sender, message, orderComplete);
            }
        } else {
            await sendReplyWithButton(sender, 'No orders found.');
        }
    } catch (error) {
        console.error("Error tracking order status: ", error.stack);
        await sendReplyWithButton(sender, 'Oops, something went wrong....');
    }
}

async function trackOrderByID(sender, orderId) {
    try {
        const hotelId = hotelIds[sender].hotelId;
        const Order = getOrderModel(hotelId);
        const order = await Order.findOne({ orderId, sender });
        if (order) {
            let message;
            let orderComplete = false;
            switch (order.status) {
                case 'Accepted':
                    message = 'Your order is confirmed.';
                    break;
                case 'Rejected':
                    message = "Sorry to say this, \nWe couldn't complete your order.\nSEND 'hi' to order again.";
                    break;
                case 'Cooking':
                    message = 'Your food is being prepared.';
                    break;
                case 'Ready':
                    message = 'Your order is ready. Please collect your item.';
                    orderComplete = true;
                    break;
                case 'Cancelled':
                    message = 'Your order was cancelled.';
                    orderComplete = true;
                    break;
                case 'Completed':
                    message = 'Your order has been completed. Thank you!';
                    orderComplete = true;
                    break;
                default:
                    message = "Wait while your order is being confirmed.";
            }
            if (order.status === 'Pending') {
                message += "\nIf you wish to cancel your order, click the button below.";
                await sendReplyWithCancelOption(sender, message, order.orderId);
            } else {
                await sendReplyWithButton(sender, message, orderComplete);
            }
        } else {
            await sendReplyWithButton(sender, 'No order found with the provided ID.');
        }
    } catch (error) {
        console.error("Error tracking order by ID: ", error.stack);
        await sendReplyWithButton(sender, 'Oops, something went wrong....');
    }
}

async function cancelOrder(sender, orderId) {
    try {
        const hotelId = hotelIds[sender].hotelId;
        const Order = getOrderModel(hotelId);
        const order = await Order.findOne({ orderId, sender });
        if (order && order.status === 'Pending') {
            order.status = 'Cancelled';
            await order.save().catch(err => {
                console.error(`Error saving order ${order.orderId}:`, err.stack);
            });
            await sendReply(sender, `Your order with ID ${orderId} has been cancelled.`);
        } else {
            await sendReply(sender, 'Cannot cancel the order. Either the order does not exist or it is not in a cancellable state.');
        }
    } catch (error) {
        console.error("Error cancelling order: ", error.stack);
        await sendReply(sender, 'Oops, something went wrong....');
    }
}

async function sendReplyWithCancelOption(sender, reply, orderId) {
    const message = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: sender,
        type: "interactive",
        interactive: {
            type: "button",
            body: {
                text: reply
            },
            action: {
                buttons: [
                    { type: "reply", reply: { id: `CancelOrder_${orderId}`, title: "Cancel Order" } },
                    { type: "reply", reply: { id: "DisconnectHotel", title: "Disconnect Hotel" } }
                ]
            }
        }
    };

    try {
        const lastInteraction = getLastInteractionTimestamp(sender);
        if (isWithin24Hours(lastInteraction)) {
            const response = await axios({
                method: "POST",
                url: `https://graph.facebook.com/v13.0/${phone_number_id}/messages?access_token=${token}`,
                data: message,
                headers: {
                    "Content-Type": "application/json"
                }
            });
            console.log('Message with cancel option sent:', response.data);
        } else {
            // Send a template message to re-engage the user
            await sendTemplateMessage(sender, 'your_template_name');  // Replace with your template name
        }
    } catch (error) {
        console.error('Error sending message with cancel option:', error.stack);
    }
}

async function sendTrackOrderOptions(sender) {
    const optionsMessage = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: sender,
        type: "interactive",
        interactive: {
            type: "button",
            body: {
                text: "Choose an option to track your order:"
            },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "TrackCurrentOrder", title: "Track Current Order" } },
                    { type: "reply", reply: { id: "TrackOrderByID", title: "Track Order by ID" } },
                    { type: "reply", reply: { id: "DisconnectHotel", title: "Disconnect Hotel" } }
                ]
            }
        }
    };

    await sendReplyInteractive(sender, optionsMessage);
}

// Root route to ensure the app is up
app.get("/", (req, res) => {
    res.status(200).send(`Hello, this is webhook setup on port ${port}`);
});

async function sendPaymentLinkWithButtons(sender, paymentLink, totalAmount) {
    const message = {
        messaging_product: "whatsapp",
        to: sender,
        type: "interactive",
        interactive: {
            type: "button",
            body: {
                text: `Your total bill amount is ₹${totalAmount}. Please click the link below to pay via Razorpay:\n\n${paymentLink}`
            },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "PaymentCompleted", title: "Payment Completed" } },
                    { type: "reply", reply: { id: "CancelOrder", title: "Cancel Order" } },
                    { type: "reply", reply: { id: "DisconnectHotel", title: "Disconnect Hotel" } }
                ]
            }
        }
    };

    try {
        const lastInteraction = getLastInteractionTimestamp(sender);
        if (isWithin24Hours(lastInteraction)) {
            const response = await axios({
                method: "POST",
                url: `https://graph.facebook.com/v13.0/${phone_number_id}/messages?access_token=${token}`,
                data: message,
                headers: {
                    "Content-Type": "application/json"
                }
            });
            console.log('Payment link sent successfully:', response.data);
        } else {
            // Send a template message to re-engage the user
            await sendTemplateMessage(sender, 'your_template_name');  // Replace with your template name
        }
    } catch (error) {
        console.error('Error sending payment link:', error.stack);
    }
}

// Helper functions for tracking user interaction
function updateLastInteraction(sender) {
    userInteractionTimestamps[sender] = Date.now();
}

function getLastInteractionTimestamp(sender) {
    return userInteractionTimestamps[sender] || 0;
}

function isWithin24Hours(timestamp) {
    return (Date.now() - timestamp) < 24 * 60 * 60 * 1000;
}
