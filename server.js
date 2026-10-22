require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Environment variables & network binding
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ponte_concierge_secure_token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || 'your_meta_permanent_access_token';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || 'your_whatsapp_phone_number_id';

// ==========================================
// 1. WEBHOOK VERIFICATION (GET /webhook)
// ==========================================
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
// 2. EVENT LISTENER & ROUTER (POST /webhook)
// ==========================================
app.post('/webhook', async (req, res) => {
  const body = req.body;
res.sendStatus(200);
  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry) {
      for (const change of entry.changes) {
        const value = change.value;
        
        if (value && value.messages && value.messages.length > 0) {
          const message = value.messages[0];
          const senderPhone = message.from;
          const messageId = message.id;
          
          console.log(`Received message from ${senderPhone} (ID: ${messageId})`);

         // Direct Text Messages
        if (message.type === 'text') {
          const messageBody = message.body.text.body.toLowerCase().trim();
          console.log(`Text Content: "${messageBody}"`);
          
          if (messageBody.includes('parcel') || messageBody.includes('fetch')) {
            await sendWhatsAppFlow(
              senderPhone, 
              "2210586496532912", // Your Package Collect / Parcel Fetch Flow ID
              "PARCEL_DETAILS", 
              "Fetch Parcel", 
              "Tap below to request a parcel runner."
            );
          } else if (messageBody.includes('pass') || messageBody.includes('visitor')) {
            await sendWhatsAppFlow(
              senderPhone, 
              "259347371166581", // Your Visitor Pass Flow ID
              "VISITOR_INFO", 
              "Issue Pass", 
              "Tap below to pre-clear a visitor."
            );
          } else {
            await sendWhatsAppMessage(
              senderPhone,
              `Ponte Concierge received: "${messageBody}". Type 'parcel' to fetch a package or 'pass' for a visitor pass.`
            );
          }
        }

          // Interactive Flow Responses
          } else if (message.type === 'interactive') {
            const interactiveType = message.interactive.type;
            console.log(`Interactive Type: ${interactiveType}`);

            if (interactiveType === 'nfm_reply') {
              const responseJson = JSON.parse(message.interactive.nfm_reply.response_json);
              console.log('Flow Response Payload:', responseJson);

              // Route 1: Parcel Fetch Flow Submission
              if (responseJson.unit_number) {
                console.log(`📦 Parcel Request - Unit: ${responseJson.unit_number}, Courier: ${responseJson.courier_name}`);
                
                await sendWhatsAppMessage(
                  senderPhone, 
                  `📦 *Runner Dispatched!*\n\nUnit: ${responseJson.unit_number}\nCourier: ${responseJson.courier_name}\nNotes: ${responseJson.special_instructions || 'None'}\n\nOur concierge runner is retrieving your package now.`
                );

              // Route 2: Visitor Pass Flow Submission
              } else if (responseJson.visitor_name) {
                console.log(`🎫 Visitor Pass - Name: ${responseJson.visitor_name}, Access: ${responseJson.entry_type}`);
                
                await sendWhatsAppMessage(
                  senderPhone, 
                  `🎫 *Gate Pass Approved!*\n\nVisitor: ${responseJson.visitor_name}\nType: ${responseJson.entry_type}\nVehicle: ${responseJson.vehicle_reg || 'N/A'}\n\nSecurity at the entry gate has been notified. Your visitor is pre-cleared.`
                );
              }
            }
          }
        }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  } else {
    return res.sendStatus(404);
  }
});
// Health check route to clear "Cannot GET /"
app.get('/', (req, res) => {
  return res.status(200).send('Ponte Concierge Webhook Service is Active 🚀');
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
// 4. HELPER: SEND WHATSAPP FLOW
async function sendWhatsAppFlow(recipientPhone, flowId, screenName, ctaText, bodyText) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.PHONE_NUMBER_ID;

  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: recipientPhone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: bodyText },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_id: flowId,
          flow_cta: ctaText,
          flow_action: "navigate",
          flow_action_payload: {
            screen: screenName
          }
        }
      }
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  return await response.json();
}
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  return await response.json();
}
// Start Server
app.listen(PORT, HOST, () => {
  console.log(`Ponte Concierge webhook server is running on http://${HOST}:${PORT}`);
});
