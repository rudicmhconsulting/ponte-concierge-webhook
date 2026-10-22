const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const VERIFY_TOKEN = 'ponte_concierge_secure_token';

// 1. WEBHOOK VERIFICATION (GET /webhook)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  } else {
    return res.sendStatus(403);
  }
});

// 2. EVENT LISTENER & ROUTER (POST /webhook)
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  return; // Terminate immediately to prevent header conflicts

  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          const value = change.value;

          if (value && value.messages && value.messages.length > 0) {
            const message = value.messages[0];
            const senderPhone = message.from;

            // Direct Text Messages
            if (message.type === 'text') {
              const messageBody = message.text.body.toLowerCase().trim();
              console.log(`💬 Text Content: "${messageBody}"`);

              if (messageBody.includes('parcel') || messageBody.includes('fetch') || messageBody.includes('collect')) {
                await sendWhatsAppFlow(
                  senderPhone, 
                  "2210586496532912", 
                  "PARCEL_DETAILS", 
                  "Fetch Parcel", 
                  "Tap below to request a parcel runner."
                );
              } else if (messageBody.includes('pass') || messageBody.includes('visitor')) {
                await sendWhatsAppFlow(
                  senderPhone, 
                  "2593473711166581", 
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
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Error processing webhook:', err);
  }
});

// Health check route
app.get('/', (req, res) => {
  return res.status(200).send('Ponte Concierge Webhook Service is Active 🚀');
});

// 3. HELPER: SEND TEXT MESSAGE
async function sendWhatsAppMessage(recipientPhone, messageText) {
  try {
    await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'text',
        text: { body: messageText },
      }),
    });
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.message);
  }
}

// 4. HELPER: SEND WHATSAPP FLOW
async function sendWhatsAppFlow(recipientPhone, flowId, screenName, ctaText, bodyText) {
  try {
    const url = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`;
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
        "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    return await response.json();
  } catch (error) {
    console.error('❌ Error sending WhatsApp Flow:', error.message);
  }
}

// Start Server
app.listen(PORT, HOST, () => {
  console.log(`🚀 Ponte Concierge webhook server is running on http://${HOST}:${PORT}`);
});
