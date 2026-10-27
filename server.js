const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const VERIFY_TOKEN = 'ponte_concierge_secure_token';

// In-memory state store for runner dispatch and visitor session tracking
const activeJobs = new Map();
const visitorSessions = new Map(); // Tracks multi-step resident requests

// 1. WEBHOOK VERIFICATION (GET /webhook)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ WEBHOOK_VERIFIED');
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
  res.sendStatus(200); // Immediate 200 OK acknowledgment to Meta

  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;

          if (value && value.messages && value.messages.length > 0) {
            const message = value.messages[0];
            const senderPhone = message.from;

            // ==========================================
            // CASE A: RUNNER / VISITOR BUTTON CLICKS
            // ==========================================
            if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
              const buttonId = message.interactive.button_reply.id;
              console.log(`🔘 Button clicked by ${senderPhone}: ${buttonId}`);

              // --- 1. RUNNER ACTIONS ---
              if (buttonId.startsWith('JOB_ACCEPT_')) {
                const jobId = buttonId.replace('JOB_ACCEPT_', '');
                const job = activeJobs.get(jobId);

                if (!job) {
                  await sendWhatsAppMessage(senderPhone, `⚠️ Job #${jobId} is no longer available.`);
                  return;
                }

                if (job.status === 'ASSIGNED') {
                  await sendWhatsAppMessage(senderPhone, `❌ Snooze you lose! Job #${jobId} was already claimed.`);
                  return;
                }

                job.status = 'ASSIGNED';
                job.runner = senderPhone;
                activeJobs.set(jobId, job);

                await sendWhatsAppMessage(
                  senderPhone,
                  `✅ *Job #${jobId} Confirmed!*\n\nHead to Reception and present token: *[PK-${jobId}]* to collect the parcel for *Unit ${job.unit}*.\n\n💰 R${job.payout.toFixed(2)} will be credited upon delivery verification.`
                );
              } else if (buttonId.startsWith('JOB_DECLINE_')) {
                await sendWhatsAppMessage(senderPhone, `👍 Job declined. You remain active on the standby runner roster.`);
              }

              // --- 2. VISITOR PASS SELECTION ---
              else if (buttonId.startsWith('VISITOR_TYPE_')) {
                const entryType = buttonId.replace('VISITOR_TYPE_', '');
                const session = visitorSessions.get(senderPhone) || { visitorName: 'Guest' };
                const passToken = `PONTE-${Math.floor(100000 + Math.random() * 900000)}`;
                const qrData = encodeURIComponent(`https://ponte.concierge/access?token=${passToken}&type=${entryType}`);
                const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${qrData}`;

                await sendWhatsAppImage(
                  senderPhone,
                  qrImageUrl,
                  `🎟️ *PONTE ACCESS PASS ISSUED*\n\n` +
                  `• *Visitor:* ${session.visitorName}\n` +
                  `• *Entry Type:* ${entryType.toUpperCase()}\n` +
                  `• *Pass Code:* ${passToken}\n` +
                  `• *Valid:* Today only (Single Entry)\n\n` +
                  `_Present this QR code to the scanner at the pedestrian turnstile or vehicle boom gate._`
                );

                visitorSessions.delete(senderPhone);
              }
              return;
            }

            // ==========================================
            // CASE B: INBOUND TEXT MESSAGES
            // ==========================================
            if (message.type === 'text') {
              const textRaw = message.text.body.trim();
              const messageBody = textRaw.toLowerCase();
              console.log(`💬 Inbound text from ${senderPhone}: "${messageBody}"`);

              // Check if waiting for visitor name
              if (visitorSessions.has(senderPhone) && visitorSessions.get(senderPhone).step === 'AWAITING_NAME') {
                visitorSessions.set(senderPhone, { visitorName: textRaw, step: 'SELECT_TYPE' });
                await sendVisitorTypeOptions(senderPhone, textRaw);
                return;
              }

              // 1. RUNNER TEST DISPATCH TRIGGER
              if (messageBody === 'run' || messageBody === 'testjob') {
                const testId = Math.floor(1000 + Math.random() * 9000).toString();
                const newJob = {
                  id: testId,
                  unit: '3204',
                  courier: 'Takealot',
                  payout: 25.00,
                  status: 'OPEN'
                };
                activeJobs.set(testId, newJob);
                await sendRunnerJob(senderPhone, newJob);
              } 
              // 2. VISITOR PRE-CLEARANCE TRIGGER
              else if (messageBody.includes('pass') || messageBody.includes('visitor')) {
                visitorSessions.set(senderPhone, { step: 'AWAITING_NAME' });
                await sendWhatsAppMessage(
                  senderPhone,
                  `🛡️ *Ponte Visitor Pre-Clearance*\n\nPlease reply with your guest's *Full Name* (e.g., Sipho Dlamini):`
                );
              } 
              // 3. PARCEL FETCH SIMULATION
              else if (messageBody.includes('parcel') || messageBody.includes('fetch') || messageBody.includes('collect')) {
                const testId = Math.floor(1000 + Math.random() * 9000).toString();
                const newJob = {
                  id: testId,
                  unit: '3204',
                  courier: 'Reception Parcel Desk',
                  payout: 25.00,
                  status: 'OPEN'
                };
                activeJobs.set(testId, newJob);
                await sendRunnerJob(senderPhone, newJob);
              } 
              // 4. MAIN MENU DEFAULT
              else {
                await sendWhatsAppMessage(
                  senderPhone,
                  `👋 *Welcome to Ponte Concierge!*\n\n` +
                  `• Text *run* to test the Runner Dispatch Job Box\n` +
                  `• Text *visitor* for visitor gate clearance & QR Pass\n` +
                  `• Text *parcel* to request an apartment delivery runner`
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

// ==========================================
// 3. MESSAGING HELPERS
// ==========================================

// Helper: Standard Text Message
async function sendWhatsAppMessage(recipientPhone, messageText) {
  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
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
    return await response.json();
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.message);
  }
}

// Helper: Image Message (Used for QR Passes)
async function sendWhatsAppImage(recipientPhone, imageUrl, captionText) {
  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone,
        type: 'image',
        image: {
          link: imageUrl,
          caption: captionText
        }
      }),
    });
    return await response.json();
  } catch (error) {
    console.error('❌ Error sending WhatsApp image:', error.message);
  }
}

// Helper: Visitor Access Type Button Selector
async function sendVisitorTypeOptions(recipientPhone, visitorName) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: {
          type: 'text',
          text: '🛡️ SELECT ACCESS TYPE'
        },
        body: {
          text: `Issuing pass for *${visitorName}*.\nHow will your guest arrive at Ponte?`
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: { id: 'VISITOR_TYPE_pedestrian', title: '🚶 Pedestrian' }
            },
            {
              type: 'reply',
              reply: { id: 'VISITOR_TYPE_vehicle', title: '🚗 Vehicle' }
            },
            {
              type: 'reply',
              reply: { id: 'VISITOR_TYPE_ehailing', title: '🚕 Uber / Bolt' }
            }
          ]
        }
      }
    };

    const response = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });
    return await response.json();
  } catch (error) {
    console.error('❌ Error sending Visitor options:', error.message);
  }
}

// Helper: Runner Job Box (Native Interactive Buttons)
async function sendRunnerJob(runnerPhone, job) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: runnerPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: {
          type: 'text',
          text: '📦 PONTE CONCIERGE RUNNER'
        },
        body: {
          text: `*New Task Available!*\n\n` +
                `• *Job ID:* #${job.id}\n` +
                `• *Pickup:* Reception Desk\n` +
                `• *Destination:* Unit ${job.unit}\n` +
                `• *Courier/Item:* ${job.courier}\n` +
                `• *Payout:* R${job.payout.toFixed(2)}`
        },
        footer: {
          text: 'Tap to claim — first to accept gets the run.'
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: `JOB_ACCEPT_${job.id}`,
                title: 'Accept Run 🚀'
              }
            },
            {
              type: 'reply',
              reply: {
                id: `JOB_DECLINE_${job.id}`,
                title: 'Decline'
              }
            }
          ]
        }
      }
    };

    const response = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    console.log(`📦 Dispatched Job #${job.id} to ${runnerPhone}`);
    return data;
  } catch (error) {
    console.error('❌ Error sending Runner Job:', error.message);
  }
}

// Start Server
app.listen(PORT, HOST, () => {
  console.log(`🚀 Ponte Concierge webhook server is running on http://${HOST}:${PORT}`);
});
