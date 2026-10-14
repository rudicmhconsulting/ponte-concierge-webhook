require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Environment variables
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ponte_concierge_secure_token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || 'your_meta_permanent_access_token';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || 'your_whatsapp_phone_number_id';

// ==========================================
// 1. WEBHOOK VERIFICATION (GET /webhook)
// ==========================================
// Meta calls this endpoint to verify your webhook URL during setup.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// ==========================================
// 2. EVENT LISTENER & PARSER (POST /webhook)
// ==========================================
// Meta posts incoming messages, status updates, and interactive flow responses here.
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Check if this is an event from a WhatsApp business account
  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry) {
      for (const change of entry.changes) {
        const value = change.value;
        
        // Ensure there are incoming messages
        if (value && value.messages && value.messages.length > 0) {
          const message = value.messages[0];
          const senderPhone = message.from; // e.g., '27821234567'
          const messageId = message.id;
          
          console.log(`Received message from ${senderPhone} (ID: ${messageId})`);

          // Route based on message type
          if (message.type === 'text') {
            const messageBody = message.text.body;
            console.log(`Text Content: "${messageBody}"`);
            
            // Example automated auto-reply for testing
            await sendWhatsAppMessage(senderPhone, `Ponte Concierge received: "${messageBody}". We are setting up your request!`);

// Replace the interactive section inside your POST /webhook block in server.js with this:

          } else if (message.type === 'interactive') {
            const interactiveType = message.interactive.type;
            console.log(`Interactive Type: ${interactiveType}`);

            if (interactiveType === 'nfm_reply') {
              // Parse the JSON payload returned from the WhatsApp Flow submission
              const responseJson = JSON.parse(message.interactive.nfm_reply.response_json);
              console.log('Flow Response Payload:', responseJson);

              // Route based on which flow form was submitted
              if (responseJson.unit_number) {
                // This is a Parcel Fetch Request
                console.log(`📦 Parcel Request - Unit: ${responseJson.unit_number}, Courier: ${responseJson.courier_name}`);
                await sendWhatsAppMessage(
                  senderPhone, 
                  `📦 Runner requested for Unit ${responseJson.unit_number} (${responseJson.courier_name}). Our team is on it!`
                );
              } else if (responseJson.visitor_name) {
                // This is a Visitor Pass Request
                console.log(`🎫 Visitor Pass - Name: ${responseJson.visitor_name}, Type: ${responseJson.entry_type}`);
                await sendWhatsAppMessage(
                  senderPhone, 
                  `🎫 Gate pass generated for ${responseJson.visitor_name}. Security has been notified for your ${responseJson.entry_type} entry.`
                );
              }
            }
          }
            if (interactiveType === 'nfm_reply') {
              // This is the payload returned when a resident completes a WhatsApp Flow (e.g., parcel fetch or visitor pass)
              const responseJson = JSON.parse(message.interactive.nfm_reply.response_json);
              console.log('Flow Response Payload:', responseJson);

              await sendWhatsAppMessage(senderPhone, `Thank you! Your flow submission has been successfully logged.`);
            }
          }
        }
      }
    }
    // Return a 200 OK response to acknowledge receipt of the event
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// ==========================================
// 3. HELPER: SEND WHATSAPP MESSAGE
// ==========================================
async function sendWhatsAppMessage(recipientPhone, messageText) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'text',
        text: { body: messageText },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`Reply sent successfully to ${recipientPhone}`);
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
  }
}

// Start Server
app.listen(PORT, () => {
  console.log(`Ponte Concierge webhook server is running on port ${PORT}`);
});
