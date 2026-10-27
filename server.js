const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const VERIFY_TOKEN = 'ponte_concierge_secure_token';

// In-memory state machine for runner assignments during SIT
const activeJobs = new Map();

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
  // Acknowledge receipt to Meta immediately so they don't retry
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;

          if (value && value.messages && value.messages.length > 0) {
            const message = value.messages[0];
            const senderPhone = message.from;

            // --- CASE A: RUNNER CLICKED AN INTERACTIVE BUTTON ---
            if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
              const buttonId = message.interactive.button_reply.id;
              console.log(`🔘 Button clicked by ${senderPhone}: ${buttonId}`);

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
                  `✅ *Job #${jobId} Confirmed!*\n\nHead to Reception and present token: *[PK-${jobId}]* to collect the parcel for *Unit ${job.unit}*.\n\n💰 R${job.payout.toFixed(2)} will be credited upon delivery.`
                );
              } else if (buttonId.startsWith('JOB_DECLINE_')) {
                await sendWhatsAppMessage(senderPhone, `👍 Job declined. You remain on the active runner roster.`);
              }
              return;
            }

            // --- CASE B: DIRECT TEXT MESSAGES ---
            if (message.type === 'text') {
              const messageBody = message.text.body.toLowerCase().trim();
              console.log(`💬 Inbound text from ${senderPhone}: "${messageBody}"`);

              // Test runner dispatch
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
              else if (messageBody.includes('pass') || messageBody.includes('visitor')) {
                await sendWhatsAppMessage(
                  senderPhone,
                  `🛡️ *Ponte Visitor Pre-Clearance*\n\nPlease reply with your guest's *Full Name* and *Access Type* (e.g. Sipho Dlamini, Pedestrian).`
                );
              } 
              else {
                await sendWhatsAppMessage(
                  senderPhone,
                  `👋 *Welcome to Ponte Concierge!*\n\n• Text *run* to test the Runner Dispatch Job Box\n• Text *visitor* for visitor gate clearance\n• Text *parcel* to check arriving couriers`
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
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.message);
  }
}

// 4. HELPER: SEND RUNNER JOB BOX (NATIVE BUTTONS)
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
